import { access, mkdir, readdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { constants as fsConstants } from 'node:fs';
import { pathToFileURL } from 'node:url';

const NOTION_VERSION = '2026-03-11';
const DIALOGUE_DATABASE = {
  id: '3bd4fddb0aaa800da296f7f5b460c014',
  expectedProperties: ['PC一覧', 'セリフ', 'シーン'],
};
const CHARACTERS_DIR = 'characters';

const PROPERTY_ALIASES = {
  character: ['PC一覧'],
  text: ['セリフ'],
  scene: ['シーン'],
  date: ['月日'],
  choiceLabel: ['選択肢ボタン用', 'テキスト'],
  size: ['文字サイズ', '文字サイズ（変更の場合のみ）'],
  animation: ['アニメーション', '文字装', '文字装飾'],
  color: ['文字色'],
  font: ['フォント'],
  expression: ['表情'],
  memo: ['メモ'], // 人間用。JSONには出さない。
};

const FONT_KEY_MAP = new Map(Object.entries({
  'ゴシック（標準）': 'gothic',
  'Noto Sans JP': 'notoSans',
  'Noto Sans JP Black': 'notoBlack',
  'M PLUS 1p': 'mplus',
  'M PLUS Rounded': 'rounded',
  'M PLUS Rounded 1c': 'rounded',
  'Zen Maru Gothic': 'zenMaru',
  '明朝（標準）': 'serif',
  'Noto Serif JP': 'notoSerif',
  'Shippori Mincho': 'shippori',
  'Dela Gothic One': 'dela',
  'Reggae One': 'reggae',
  'RocknRoll One': 'rocknroll',
  'Rampart One': 'rampart',
  'Train One': 'train',
  'Yuji Boku': 'yujiBoku',
  'New Tegomin': 'newTegomin',
  'Hina Mincho': 'hina',
  'Stick': 'stick',
  'Kaisei Decol': 'kaisei',
  'Mochiy Pop One': 'mochiy',
  'Mochiy Pop P One': 'mochiyP',
  'Potta One': 'potta',
  'Hachi Maru Pop': 'hachi',
  'Yusei Magic': 'yusei',
  'Kosugi Maru': 'kosugiMaru',
  'Klee One': 'klee',
  'Zen Kurenaido': 'zenKurenaido',
  'Yomogi': 'yomogi',
  'DotGothic16': 'dot',
  'M PLUS 1 Code': 'mplusCode',
  'BIZ UDMincho': 'bizUdMincho',
  'Shippori Antique B1': 'shipporiAntiqueB1',
  'Kaisei HarunoUmi': 'kaiseiHarunoUmi',
  'WDXL Lubrifont JP N': 'wdxlLubrifont',
}));

const ANIMATION_KEY_MAP = new Map(Object.entries({
  '小刻みに震える': 'tremble',
  '激しく震える': 'shake',
  'ゆらゆら': 'sway',
  'ふわふわ': 'float',
  '脈打つ': 'pulse',
  'ぴょこぴょこ': 'bounce',
  '点滅': 'blink',
  'グリッチ': 'glitch',
}));
const INTERNAL_ANIMATIONS = new Set(['tremble', 'shake', 'sway', 'float', 'pulse', 'bounce', 'blink', 'glitch']);
const INTERNAL_FONT_KEYS = new Set(FONT_KEY_MAP.values());

function createNotionClient(token) {
  if (!token) throw new Error('NOTION_TOKEN がありません。GitHub Actions の Repository secret を確認してください。');

  return async function notion(path, options = {}) {
    const response = await fetch(`https://api.notion.com/v1${path}`, {
      ...options,
      headers: {
        Authorization: `Bearer ${token}`,
        'Notion-Version': NOTION_VERSION,
        'Content-Type': 'application/json',
        ...(options.headers || {}),
      },
    });

    if (!response.ok) {
      const body = await response.text();
      throw new Error(`Notion API ${response.status} ${path}\n${body}`);
    }
    return response.json();
  };
}

function dashedId(id) {
  const s = String(id || '').replaceAll('-', '');
  if (!/^[0-9a-f]{32}$/i.test(s)) return String(id || '');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

async function listAllBlockChildren(notion, blockId) {
  const results = [];
  let startCursor;
  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (startCursor) params.set('start_cursor', startCursor);
    const response = await notion(`/blocks/${dashedId(blockId)}/children?${params.toString()}`);
    results.push(...(response.results || []));
    startCursor = response.has_more ? response.next_cursor : null;
  } while (startCursor);
  return results;
}

async function findChildDatabases(notion, rootBlockId, maxDepth = 6) {
  const found = [];
  const seen = new Set();

  async function walk(blockId, depth) {
    if (depth > maxDepth || seen.has(blockId)) return;
    seen.add(blockId);
    const children = await listAllBlockChildren(notion, blockId);
    for (const block of children) {
      if (block.type === 'child_database') {
        found.push({ id: block.id, title: block.child_database?.title || '' });
      }
      if (block.has_children && block.type !== 'child_database') {
        await walk(block.id, depth + 1);
      }
    }
  }

  await walk(rootBlockId, 0);
  return found;
}

async function scoreDatabase(notion, databaseId, config) {
  const db = await notion(`/databases/${dashedId(databaseId)}`);
  const sources = Array.isArray(db.data_sources) ? db.data_sources : [];
  let best = null;
  for (const source of sources) {
    const schema = await notion(`/data_sources/${source.id}`);
    const names = new Set(Object.keys(schema.properties || {}));
    const score = config.expectedProperties.filter(name => names.has(name)).length;
    if (!best || score > best.score) best = { id: source.id, schema, score, databaseId: db.id };
  }
  return best;
}

async function findDataSource(notion, config) {
  try {
    const direct = await scoreDatabase(notion, config.id, config);
    if (direct) return direct;
  } catch (error) {
    const message = String(error?.message || error);
    if (!/is a page, not a database/i.test(message)) throw error;
    console.log(`Notion page ${config.id} 内のデータベースを探索します。`);
  }

  const childDatabases = await findChildDatabases(notion, config.id);
  if (!childDatabases.length) {
    throw new Error(`Notion page ${config.id} 内に child database が見つかりません。`);
  }

  let best = null;
  for (const candidate of childDatabases) {
    try {
      const scored = await scoreDatabase(notion, candidate.id, config);
      if (!scored) continue;
      scored.databaseTitle = candidate.title;
      if (!best || scored.score > best.score) best = scored;
    } catch (error) {
      console.warn(`child database ${candidate.id} (${candidate.title}) は利用できません: ${error.message}`);
    }
  }
  if (!best) throw new Error('セリフDBの data source を取得できませんでした。');
  return best;
}

async function queryAll(notion, dataSourceId) {
  const results = [];
  let startCursor;
  do {
    const body = { page_size: 100, result_type: 'page' };
    if (startCursor) body.start_cursor = startCursor;
    const response = await notion(`/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: JSON.stringify(body),
    });
    results.push(...(response.results || []).filter(item => item.object === 'page'));
    startCursor = response.has_more ? response.next_cursor : null;
  } while (startCursor);
  return results;
}

function richTextPlain(arr) {
  return Array.isArray(arr) ? arr.map(x => x?.plain_text ?? x?.text?.content ?? '').join('').trim() : '';
}

function propertyTextsSync(prop) {
  if (!prop || !prop.type) return [];
  switch (prop.type) {
    case 'title': return [richTextPlain(prop.title)].filter(Boolean);
    case 'rich_text': return [richTextPlain(prop.rich_text)].filter(Boolean);
    case 'select': return [prop.select?.name].filter(Boolean);
    case 'status': return [prop.status?.name].filter(Boolean);
    case 'multi_select': return (prop.multi_select || []).map(item => item?.name).filter(Boolean);
    case 'number': return prop.number == null ? [] : [String(prop.number)];
    case 'url': return [prop.url].filter(Boolean);
    case 'unique_id': return prop.unique_id?.number == null ? [] : [String(prop.unique_id.number)];
    case 'formula': {
      const f = prop.formula || {};
      if (f.type === 'string') return [f.string].filter(Boolean);
      if (f.type === 'number' && f.number != null) return [String(f.number)];
      if (f.type === 'boolean' && f.boolean != null) return [String(f.boolean)];
      if (f.type === 'date' && f.date?.start) return [f.date.start];
      return [];
    }
    case 'rollup': {
      const r = prop.rollup || {};
      if (r.type === 'array') return (r.array || []).flatMap(propertyTextsSync);
      if (r.type === 'number' && r.number != null) return [String(r.number)];
      if (r.type === 'date' && r.date?.start) return [r.date.start];
      return [];
    }
    default: return [];
  }
}

function firstExistingProperty(page, aliases) {
  for (const name of aliases) {
    if (page.properties?.[name]) return { name, prop: page.properties[name] };
  }
  return null;
}

function firstText(page, aliases) {
  const found = firstExistingProperty(page, aliases);
  if (!found) return '';
  return propertyTextsSync(found.prop)[0] || '';
}

function allTexts(page, aliases) {
  const found = firstExistingProperty(page, aliases);
  return found ? propertyTextsSync(found.prop) : [];
}

async function getFullRelationIds(notion, page, aliases) {
  const found = firstExistingProperty(page, aliases);
  if (!found || found.prop.type !== 'relation') return [];
  const direct = (found.prop.relation || []).map(item => item.id).filter(Boolean);
  if (!found.prop.has_more) return direct;

  const ids = [];
  let startCursor;
  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (startCursor) params.set('start_cursor', startCursor);
    const response = await notion(`/pages/${page.id}/properties/${encodeURIComponent(found.prop.id)}?${params.toString()}`);
    for (const item of response.results || []) {
      if (item.type === 'relation' && item.relation?.id) ids.push(item.relation.id);
    }
    startCursor = response.has_more ? response.next_cursor : null;
  } while (startCursor);
  return ids;
}

function detectParentRelationProperty(schema, pages, dataSourceId) {
  const selfRelations = Object.entries(schema.properties || {}).filter(([, prop]) => {
    return prop?.type === 'relation' && dashedId(prop.relation?.data_source_id) === dashedId(dataSourceId);
  });

  if (!selfRelations.length) {
    throw new Error('サブアイテム用の自己Relationが見つかりません。Notion DBでサブアイテムを有効にしてください。');
  }

  const scored = selfRelations.map(([name, schemaProp]) => {
    let score = 0;
    if (/親|parent/i.test(name)) score += 100;
    if (/サブ|sub|子/i.test(name)) score -= 60;
    let nonEmpty = 0;
    let multi = 0;
    for (const page of pages) {
      const value = page.properties?.[name];
      const count = value?.type === 'relation' ? (value.relation || []).length : 0;
      if (count > 0) nonEmpty++;
      if (count > 1) multi++;
    }
    if (nonEmpty > 0) score += 10;
    if (multi === 0) score += 20;
    score -= multi * 2;
    return { name, id: schemaProp.id, score };
  }).sort((a, b) => b.score - a.score);

  console.log('サブアイテムRelation候補:', scored.map(x => `${x.name}(${x.score})`).join(', '));
  return scored[0].name;
}

function normalizeHexColor(value) {
  const matches = String(value || '').match(/#[0-9a-fA-F]{3,8}\b/g);
  return matches?.length ? matches[matches.length - 1] : '';
}

export function fontKeyFromNotion(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (FONT_KEY_MAP.has(raw)) return FONT_KEY_MAP.get(raw);
  if (INTERNAL_FONT_KEYS.has(raw)) return raw;
  console.warn(`未対応フォント「${raw}」は標準ゴシックで表示します。`);
  return '';
}

export function animationKeyFromNotion(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  if (ANIMATION_KEY_MAP.has(raw)) return ANIMATION_KEY_MAP.get(raw);
  if (INTERNAL_ANIMATIONS.has(raw)) return raw;
  console.warn(`未対応アニメーション「${raw}」は無視します。`);
  return '';
}

export function parseMonthDay(value) {
  const raw = String(value || '').trim();
  if (!raw) return null;
  const normalized = raw
    .replace(/[．.]/g, '/')
    .replace(/[～〜~]/g, '-')
    .replace(/\s+/g, '');

  const range = normalized.match(/^(\d{1,2})[\/-](\d{1,2})-(\d{1,2})[\/-](\d{1,2})$/);
  if (range) {
    const [, sm, sd, em, ed] = range.map(Number);
    if (validMonthDay(sm, sd) && validMonthDay(em, ed)) {
      return { type: 'period', start: `${sm}-${sd}`, end: `${em}-${ed}` };
    }
  }

  const single = normalized.match(/^(\d{1,2})[\/-](\d{1,2})$/);
  if (single) {
    const month = Number(single[1]);
    const day = Number(single[2]);
    if (validMonthDay(month, day)) return { type: 'date', date: `${month}-${day}` };
  }
  return { type: 'invalid', raw };
}

function validMonthDay(month, day) {
  return Number.isInteger(month) && Number.isInteger(day) && month >= 1 && month <= 12 && day >= 1 && day <= 31;
}

function choiceNumber(scenes) {
  let best = null;
  for (const scene of scenes) {
    const match = String(scene).trim().match(/^選択肢\s*(\d+)$/);
    if (!match) continue;
    const n = Number(match[1]);
    if (best == null || n < best) best = n;
  }
  return best;
}

function areaNumbers(scenes) {
  const out = [];
  for (const scene of scenes) {
    const match = String(scene).trim().match(/^エリア\s*(\d+)$/);
    if (match) out.push(Number(match[1]));
  }
  return [...new Set(out.filter(n => Number.isInteger(n) && n > 0))].sort((a, b) => a - b);
}

function rowSort(a, b) {
  return String(a.createdTime || '').localeCompare(String(b.createdTime || '')) || String(a.id).localeCompare(String(b.id));
}

function styleFromRow(row) {
  const style = {};
  const size = Number(row.size);
  if (Number.isFinite(size) && size > 0) style.size = size;
  if (row.color) style.color = row.color;
  if (row.font) style.font = row.font;
  if (row.animation) style.animation = row.animation;
  return Object.keys(style).length ? style : null;
}

function talkPayload(row) {
  const out = { text: String(row.text || '') };
  const style = styleFromRow(row);
  if (style) out.style = style;
  if (row.expression) out.expression = row.expression;
  return out;
}

function choicePayload(row) {
  const out = {
    label: String(row.choiceLabel || `選択肢${row.choiceNo || ''}`).trim(),
    text: String(row.text || ''),
  };
  const style = styleFromRow(row);
  if (style) out.style = style;
  if (row.expression) out.expression = row.expression;
  return out;
}

export function compileTalkTree(root, rowsByParent, warnings = []) {
  const talk = talkPayload(root);
  const next = [];

  function childrenOf(parentId) {
    return [...(rowsByParent.get(parentId) || [])].sort(rowSort);
  }

  function choicesOf(parentId) {
    return childrenOf(parentId)
      .filter(row => row.isChoice)
      .sort((a, b) => (a.choiceNo ?? 9999) - (b.choiceNo ?? 9999) || rowSort(a, b));
  }

  function appendNormalChildren(parentRow, parentSegment, isRoot) {
    const allChildren = childrenOf(parentRow.id);
    const normalChildren = allChildren.filter(row => !row.isChoice);
    const directChoices = choicesOf(parentRow.id);

    if (directChoices.length) {
      const choices = directChoices.map(choicePayload);
      if (isRoot) {
        next.push({ text: '', choices });
      } else if (parentSegment) {
        parentSegment.choices = choices;
      }
      for (const choice of directChoices) {
        if (childrenOf(choice.id).length) warnings.push(`選択肢「${choice.text}」配下のサブアイテムは現在無視します。`);
      }
    }

    if (normalChildren.length > 1) {
      warnings.push(`「${parentRow.text}」直下に通常の続きが${normalChildren.length}件あります。作成順で並べます。`);
    }

    for (const child of normalChildren) {
      const segment = talkPayload(child);
      next.push(segment);
      appendNormalChildren(child, segment, false);
    }
  }

  appendNormalChildren(root, null, true);
  if (next.length) talk.next = next;
  return talk;
}

function emptyDialogue() {
  return {
    talk: { greeting: [], normal: [], rapid: [] },
    special: { dates: [], periods: [] },
    greetingDates: [],
    greetingPeriods: [],
    areas: [],
  };
}

function areaBucket(dialogue, number) {
  const key = `area${number}`;
  let area = dialogue.areas.find(item => item.key === key);
  if (!area) {
    area = { key, talk: [], rapid: [] };
    dialogue.areas.push(area);
  }
  return area;
}

function addGroupedTalk(items, keyFields, talk) {
  let item = items.find(candidate => keyFields.every(([key, value]) => candidate[key] === value));
  if (!item) {
    item = Object.fromEntries(keyFields);
    item.talk = [];
    items.push(item);
  }
  item.talk.push(talk);
}

export function addRootTalkToDialogue(dialogue, root, compiledTalk, warnings = []) {
  const scenes = root.scenes || [];
  const normalized = scenes.map(value => String(value).trim()).filter(Boolean);
  const hasGreeting = normalized.some(value => value === 'あいさつ' || value === '挨拶');
  const hasRapid = normalized.includes('連打');
  const hasNormal = normalized.includes('通常');
  const areas = areaNumbers(normalized);
  const dateInfo = parseMonthDay(root.dateRaw);

  if (dateInfo?.type === 'invalid') warnings.push(`「${root.text}」の月日「${dateInfo.raw}」を解釈できません。通常扱いにします。`);

  let added = false;

  if (hasGreeting) {
    if (dateInfo?.type === 'date') {
      addGroupedTalk(dialogue.greetingDates, [['date', dateInfo.date]], compiledTalk);
    } else if (dateInfo?.type === 'period') {
      addGroupedTalk(dialogue.greetingPeriods, [['start', dateInfo.start], ['end', dateInfo.end]], compiledTalk);
    } else {
      dialogue.talk.greeting.push(compiledTalk);
    }
    added = true;
  }

  if (areas.length) {
    if (dateInfo && dateInfo.type !== 'invalid') warnings.push(`「${root.text}」はエリア指定と月日指定を併用しています。エリア側では月日を無視します。`);
    for (const number of areas) {
      const area = areaBucket(dialogue, number);
      (hasRapid ? area.rapid : area.talk).push(compiledTalk);
    }
    added = true;
  }

  if (hasRapid && !areas.length) {
    dialogue.talk.rapid.push(compiledTalk);
    added = true;
  }

  const onlyControlTags = normalized.filter(value => !/^選択肢\s*\d+$/.test(value));
  const implicitNormal = onlyControlTags.length === 0;
  if (hasNormal || (!added && implicitNormal)) {
    if (dateInfo?.type === 'date') {
      addGroupedTalk(dialogue.special.dates, [['date', dateInfo.date]], compiledTalk);
    } else if (dateInfo?.type === 'period') {
      addGroupedTalk(dialogue.special.periods, [['start', dateInfo.start], ['end', dateInfo.end]], compiledTalk);
    } else {
      dialogue.talk.normal.push(compiledTalk);
    }
    added = true;
  }

  if (!added) {
    // 未知のシーン名しか無い場合も台詞を捨てず、通常へ退避する。
    warnings.push(`「${root.text}」のシーン [${normalized.join(', ')}] は配置先を判定できないため通常台詞に入れます。`);
    dialogue.talk.normal.push(compiledTalk);
  }
}

async function getCharacterNo(notion, pageId, cache) {
  if (cache.has(pageId)) return cache.get(pageId);
  const promise = (async () => {
    let page;
    try {
      page = await notion(`/pages/${pageId}`);
    } catch (error) {
      throw new Error(`PC一覧のRelation先ページを読めません。キャラDBもNotion Integrationへ共有してください。\n${error.message}`);
    }

    const entries = Object.entries(page.properties || {});
    let prop = page.properties?.No;
    if (!prop) {
      const found = entries.find(([name]) => name.toLowerCase() === 'no');
      prop = found?.[1];
    }
    if (!prop) throw new Error(`Relation先キャラページ ${pageId} に「No」プロパティがありません。`);

    const text = propertyTextsSync(prop)[0] || '';
    const match = String(text).match(/\d+/);
    if (!match) throw new Error(`Relation先キャラページ ${pageId} の「No」から番号を取得できません: ${text || '(空欄)'}`);
    return String(Number(match[0]));
  })();
  cache.set(pageId, promise);
  return promise;
}

function normalizeRow(page, parentId, warnings) {
  const text = firstText(page, PROPERTY_ALIASES.text);
  const scenes = allTexts(page, PROPERTY_ALIASES.scene);
  const choiceLabel = firstText(page, PROPERTY_ALIASES.choiceLabel);
  const choiceNo = choiceNumber(scenes);
  const rawColor = firstText(page, PROPERTY_ALIASES.color);
  const color = normalizeHexColor(rawColor);
  if (rawColor && !color) warnings.push(`「${text || page.id}」の文字色「${rawColor}」からカラーコードを取得できません。`);

  const rawFont = firstText(page, PROPERTY_ALIASES.font);
  const rawAnimation = firstText(page, PROPERTY_ALIASES.animation);

  return {
    id: page.id,
    text,
    scenes,
    dateRaw: firstText(page, PROPERTY_ALIASES.date),
    choiceLabel,
    choiceNo,
    isChoice: Boolean(parentId && choiceNo != null && choiceLabel),
    size: firstText(page, PROPERTY_ALIASES.size),
    color,
    font: fontKeyFromNotion(rawFont),
    animation: animationKeyFromNotion(rawAnimation),
    expression: firstText(page, PROPERTY_ALIASES.expression),
    parentId: parentId || null,
    createdTime: page.created_time || '',
    page,
  };
}

async function ensureCharacterExists(no) {
  const jsonPath = `${CHARACTERS_DIR}/${no}/${no}.json`;
  try {
    await access(jsonPath, fsConstants.R_OK);
    return true;
  } catch {
    console.warn(`characters/${no}/${no}.json が無いため、No ${no} のdialogue.jsonは作成しません。`);
    return false;
  }
}

async function removeStaleDialogueFiles(generatedNos) {
  let entries = [];
  try {
    entries = await readdir(CHARACTERS_DIR, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    if (!entry.isDirectory() || generatedNos.has(entry.name)) continue;
    const path = `${CHARACTERS_DIR}/${entry.name}/dialogue.json`;
    try {
      await access(path, fsConstants.F_OK);
      await unlink(path);
      console.log(`削除: ${path}（Notion側に親台詞がありません）`);
    } catch {
      // 無ければ何もしない。
    }
  }
}

async function main() {
  const notion = createNotionClient(process.env.NOTION_TOKEN);
  const source = await findDataSource(notion, DIALOGUE_DATABASE);
  console.log(`セリフDB data source: ${source.id} / property match ${source.score}`);

  const schemaNames = Object.keys(source.schema.properties || {});
  console.log(`DB properties: ${schemaNames.join(', ')}`);
  for (const required of ['PC一覧', 'シーン']) {
    if (!schemaNames.includes(required)) throw new Error(`セリフDBに「${required}」プロパティがありません。`);
  }

  const pages = await queryAll(notion, source.id);
  console.log(`取得したセリフ行: ${pages.length}`);

  const parentPropertyName = detectParentRelationProperty(source.schema, pages, source.id);
  console.log(`親Relationとして「${parentPropertyName}」を使用します。`);

  const warnings = [];
  const parentIds = new Map();
  for (const page of pages) {
    const ids = await getFullRelationIds(notion, page, [parentPropertyName]);
    parentIds.set(page.id, ids[0] || null);
    if (ids.length > 1) warnings.push(`ページ ${page.id} の親Relationが複数あります。先頭だけ使用します。`);
  }

  const rows = pages.map(page => normalizeRow(page, parentIds.get(page.id), warnings));
  const rowById = new Map(rows.map(row => [row.id, row]));
  const rowsByParent = new Map();
  for (const row of rows) {
    if (row.parentId && !rowById.has(row.parentId)) {
      warnings.push(`「${row.text}」の親が取得結果に無いため、親なしとして扱います。`);
      row.parentId = null;
    }
    if (!row.parentId) continue;
    if (!rowsByParent.has(row.parentId)) rowsByParent.set(row.parentId, []);
    rowsByParent.get(row.parentId).push(row);
  }

  const roots = rows.filter(row => !row.parentId).sort(rowSort);
  const dialoguesByNo = new Map();
  const characterNoCache = new Map();

  for (const root of roots) {
    if (!root.text) {
      warnings.push(`親行 ${root.id} はセリフが空なので無視します。`);
      continue;
    }
    const relationIds = await getFullRelationIds(notion, root.page, PROPERTY_ALIASES.character);
    if (!relationIds.length) {
      warnings.push(`「${root.text}」はPC一覧が空なので無視します。`);
      continue;
    }

    const compiledTalk = compileTalkTree(root, rowsByParent, warnings);
    for (const relationId of relationIds) {
      const no = await getCharacterNo(notion, relationId, characterNoCache);
      if (!dialoguesByNo.has(no)) dialoguesByNo.set(no, emptyDialogue());
      addRootTalkToDialogue(dialoguesByNo.get(no), root, structuredClone(compiledTalk), warnings);
    }
  }

  await mkdir(CHARACTERS_DIR, { recursive: true });
  const generatedNos = new Set();
  for (const [no, dialogue] of dialoguesByNo) {
    if (!(await ensureCharacterExists(no))) continue;
    dialogue.areas.sort((a, b) => Number(a.key.replace(/\D/g, '')) - Number(b.key.replace(/\D/g, '')));
    const dir = `${CHARACTERS_DIR}/${no}`;
    await mkdir(dir, { recursive: true });
    const path = `${dir}/dialogue.json`;
    const nextText = JSON.stringify(dialogue, null, 2) + '\n';
    let oldText = '';
    try { oldText = await readFile(path, 'utf8'); } catch {}
    if (oldText !== nextText) {
      await writeFile(path, nextText, 'utf8');
      console.log(`更新: ${path}`);
    } else {
      console.log(`変更なし: ${path}`);
    }
    generatedNos.add(no);
  }

  await removeStaleDialogueFiles(generatedNos);

  for (const warning of [...new Set(warnings)]) console.warn('WARN:', warning);
  console.log(`完了: ${generatedNos.size}キャラ分のdialogue.jsonを生成しました。`);
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  main().catch(error => {
    console.error(error?.stack || error);
    process.exitCode = 1;
  });
}
