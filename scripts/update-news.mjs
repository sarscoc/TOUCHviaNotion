import { writeFile } from 'node:fs/promises';

const NOTION_TOKEN = process.env.NOTION_TOKEN;
if (!NOTION_TOKEN) {
  throw new Error('NOTION_TOKEN がありません。GitHub Actions の Repository secret を確認してください。');
}

const NOTION_VERSION = '2026-03-11';
const TIME_ZONE = 'Asia/Tokyo';

const DATABASES = {
  cf: {
    id: '1bb4fddb0aaa802a8cf1c7ccae521c68',
    publicUrl: 'https://sarsland.notion.site/1bb4fddb0aaa802a8cf1c7ccae521c68?v=1bb4fddb0aaa80339aa6000cc4c1a234&pvs=73',
    expectedProperties: ['日付', 'タグ'],
  },
  sessions: {
    id: '5664bd829fdf41ea947d8e9a185ff336',
    publicUrl: 'https://sarsland.notion.site/5664bd829fdf41ea947d8e9a185ff336?v=01dbf98ef9234f52a97e5c19fedaed08&pvs=73',
    expectedProperties: ['ᴅᴀᴛᴇ', 'ᴋᴇᴇᴘᴇʀ', 'ᴘʟᴀʏᴇʀ', 'ᴄᴏɪɴᴠᴇꜱᴛɪɢᴀᴛᴏʀꜱ', 'ɪɴᴠᴇꜱᴛɪɢᴀᴛᴏʀ'],
  },
  birthdays: {
    id: 'c234406aa26944928077fb40d749a885',
    expectedProperties: ['誕生日☑'],
  },
};

const SESSION_PERSON_PROPERTIES = [
  'ᴋᴇᴇᴘᴇʀ',
  'ᴘʟᴀʏᴇʀ',
  'ᴄᴏɪɴᴠᴇꜱᴛɪɢᴀᴛᴏʀꜱ',
  'ɪɴᴠᴇꜱᴛɪɢᴀᴛᴏʀ',
];

async function notion(path, options = {}) {
  const response = await fetch(`https://api.notion.com/v1${path}`, {
    ...options,
    headers: {
      Authorization: `Bearer ${NOTION_TOKEN}`,
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
}

function dashedId(id) {
  const s = String(id).replaceAll('-', '');
  return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
}

async function listAllBlockChildren(blockId) {
  const results = [];
  let start_cursor;
  do {
    const params = new URLSearchParams({ page_size: '100' });
    if (start_cursor) params.set('start_cursor', start_cursor);
    const response = await notion(`/blocks/${blockId}/children?${params.toString()}`);
    results.push(...(response.results || []));
    start_cursor = response.has_more ? response.next_cursor : null;
  } while (start_cursor);
  return results;
}

async function findChildDatabases(rootBlockId, maxDepth = 6) {
  const found = [];
  const seen = new Set();

  async function walk(blockId, depth) {
    if (depth > maxDepth || seen.has(blockId)) return;
    seen.add(blockId);

    const children = await listAllBlockChildren(blockId);
    for (const block of children) {
      if (block.type === 'child_database') {
        found.push({
          id: block.id,
          title: block.child_database?.title || '',
        });
      }
      if (block.has_children && block.type !== 'child_database') {
        await walk(block.id, depth + 1);
      }
    }
  }

  await walk(dashedId(rootBlockId), 0);
  return found;
}

async function scoreDatabase(databaseId, databaseConfig) {
  const db = await notion(`/databases/${dashedId(databaseId)}`);
  const sources = Array.isArray(db.data_sources) ? db.data_sources : [];
  if (!sources.length) return null;

  let best = null;
  for (const source of sources) {
    const schema = await notion(`/data_sources/${source.id}`);
    const propertyNames = new Set(Object.keys(schema.properties || {}));
    const score = databaseConfig.expectedProperties.filter(name => propertyNames.has(name)).length;
    if (!best || score > best.score) {
      best = { id: source.id, schema, score, databaseId: db.id };
    }
  }
  return best;
}

async function findDataSource(databaseConfig) {
  // まずURL由来のIDを「データベースID」として試す。
  try {
    const direct = await scoreDatabase(databaseConfig.id, databaseConfig);
    if (direct) return direct;
  } catch (error) {
    const message = String(error?.message || error);
    // Notionが「これはpageです」と返した場合は、ページ内のinline databaseを探す。
    if (!/is a page, not a database/i.test(message)) throw error;
    console.log(`Notion page ${databaseConfig.id} 内のデータベースを探索します。`);
  }

  const childDatabases = await findChildDatabases(databaseConfig.id);
  if (!childDatabases.length) {
    throw new Error(`Notion page ${databaseConfig.id} 内に child database が見つかりません。`);
  }

  let best = null;
  for (const candidate of childDatabases) {
    try {
      const scored = await scoreDatabase(candidate.id, databaseConfig);
      if (!scored) continue;
      scored.databaseTitle = candidate.title;
      if (!best || scored.score > best.score) best = scored;
    } catch (error) {
      console.warn(`child database ${candidate.id} (${candidate.title}) は利用できません: ${error.message}`);
    }
  }

  if (!best) {
    throw new Error(`Notion page ${databaseConfig.id} 内のデータベースから data source を取得できませんでした。`);
  }

  console.log(`ページ内DBを採用: ${best.databaseTitle || best.databaseId} / property match ${best.score}`);
  return best;
}

async function queryAll(dataSourceId, body = {}) {
  const results = [];
  let start_cursor;
  do {
    const payload = { page_size: 100, result_type: 'page', ...body };
    if (start_cursor) payload.start_cursor = start_cursor;
    const response = await notion(`/data_sources/${dataSourceId}/query`, {
      method: 'POST',
      body: JSON.stringify(payload),
    });
    results.push(...(response.results || []).filter(item => item.object === 'page'));
    start_cursor = response.has_more ? response.next_cursor : null;
  } while (start_cursor);
  return results;
}

function titlePropertyName(schema) {
  for (const [name, prop] of Object.entries(schema?.properties || {})) {
    if (prop?.type === 'title') return name;
  }
  return null;
}

function richTextPlain(arr) {
  return Array.isArray(arr) ? arr.map(x => x?.plain_text ?? x?.text?.content ?? '').join('').trim() : '';
}

function syncPropertyTexts(prop) {
  if (!prop || !prop.type) return [];
  switch (prop.type) {
    case 'title': return [richTextPlain(prop.title)].filter(Boolean);
    case 'rich_text': return [richTextPlain(prop.rich_text)].filter(Boolean);
    case 'select': return [prop.select?.name].filter(Boolean);
    case 'status': return [prop.status?.name].filter(Boolean);
    case 'multi_select': return (prop.multi_select || []).map(x => x?.name).filter(Boolean);
    case 'people': return (prop.people || []).map(x => x?.name).filter(Boolean);
    case 'email': return [prop.email].filter(Boolean);
    case 'phone_number': return [prop.phone_number].filter(Boolean);
    case 'url': return [prop.url].filter(Boolean);
    case 'number': return prop.number == null ? [] : [String(prop.number)];
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
      if (r.type === 'array') return (r.array || []).flatMap(syncPropertyTexts);
      if (r.type === 'number' && r.number != null) return [String(r.number)];
      if (r.type === 'date' && r.date?.start) return [r.date.start];
      return [];
    }
    default: return [];
  }
}

const relatedPageTitleCache = new Map();
async function relatedPageTitle(pageId) {
  if (relatedPageTitleCache.has(pageId)) return relatedPageTitleCache.get(pageId);
  const promise = (async () => {
    const page = await notion(`/pages/${pageId}`);
    const titleProp = Object.values(page.properties || {}).find(p => p?.type === 'title');
    return richTextPlain(titleProp?.title || []);
  })();
  relatedPageTitleCache.set(pageId, promise);
  return promise;
}

async function propertyTexts(prop) {
  if (!prop) return [];
  if (prop.type === 'relation') {
    const names = await Promise.all((prop.relation || []).map(x => relatedPageTitle(x.id)));
    return names.filter(Boolean);
  }
  return syncPropertyTexts(prop);
}

function pageTitle(page, titleName) {
  const prop = titleName ? page.properties?.[titleName] : Object.values(page.properties || {}).find(p => p?.type === 'title');
  return richTextPlain(prop?.title || []);
}

function pagePublicUrl(page, warnings, label) {
  if (page.public_url) return page.public_url;
  warnings.push(`${label}: 公開URL(public_url)が取得できませんでした。NotionでWeb公開されているか確認してください。`);
  return '';
}

function tokyoParts(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
  }).formatToParts(date);
  const get = type => Number(parts.find(p => p.type === type)?.value);
  return { year: get('year'), month: get('month'), day: get('day') };
}

function datePartsFromNotion(value) {
  if (!value) return null;
  const m = String(value).match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (!m) return null;
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

function formatAnniversaryDate(startDate, endDate) {
  const pad = value => String(value).padStart(2, '0');
  const full = date => `${date.year}/${pad(date.month)}/${pad(date.day)}`;
  const monthDay = date => `${pad(date.month)}/${pad(date.day)}`;

  if (!endDate || (
    startDate.year === endDate.year &&
    startDate.month === endDate.month &&
    startDate.day === endDate.day
  )) {
    return full(startDate);
  }

  if (startDate.year === endDate.year) {
    return `${full(startDate)} - ${monthDay(endDate)}`;
  }

  return `${full(startDate)} - ${full(endDate)}`;
}

function unique(values) {
  return [...new Set(values.map(v => String(v).trim()).filter(Boolean))];
}

async function buildCfItem(dataSource, today) {
  const start = `${today.year}-01-01`;
  const end = `${today.year + 1}-01-01`;
  const dateType = dataSource.schema?.properties?.['日付']?.type;
  const dateFilter = condition => dateType === 'formula'
    ? { property: '日付', formula: { date: condition } }
    : { property: '日付', date: condition };
  const pages = await queryAll(dataSource.id, {
    filter: {
      and: [
        dateFilter({ on_or_after: start }),
        dateFilter({ before: end }),
      ],
    },
  });

  let critical = 0;
  let fumble = 0;
  for (const page of pages) {
    const tags = (await propertyTexts(page.properties?.['タグ'])).join(' ');
    if (/critical/i.test(tags)) critical++;
    else if (/famble|fumble/i.test(tags)) fumble++;
  }

  const total = critical + fumble;
  const criticalRate = total ? (critical / total * 100) : 0;
  const fumbleRate = total ? (fumble / total * 100) : 0;

  return {
    text: `${today.year} C/F RECORD ─ ${critical} CRITICAL ${criticalRate.toFixed(1)}% / ${fumble} FUMBLE ${fumbleRate.toFixed(1)}%`,
    url: DATABASES.cf.publicUrl,
    separatorBefore: '✦',
  };
}

async function buildBirthdayItems(dataSource, warnings) {
  const birthdayType = dataSource.schema?.properties?.['誕生日☑']?.type;
  const birthdayFilter = birthdayType === 'formula'
    ? { property: '誕生日☑', formula: { checkbox: { equals: true } } }
    : { property: '誕生日☑', checkbox: { equals: true } };
  const pages = await queryAll(dataSource.id, { filter: birthdayFilter });
  const titleName = titlePropertyName(dataSource.schema);
  return pages
    .map(page => ({
      text: pageTitle(page, titleName),
      url: pagePublicUrl(page, warnings, `BIRTHDAY ${pageTitle(page, titleName) || page.id}`),
      separatorBefore: '✧',
    }))
    .filter(item => item.text);
}

async function buildAnniversaryItems(dataSource, today, warnings) {
  const dateType = dataSource.schema?.properties?.['ᴅᴀᴛᴇ']?.type;
  const dateFilter = dateType === 'formula'
    ? { property: 'ᴅᴀᴛᴇ', formula: { date: { is_not_empty: true } } }
    : { property: 'ᴅᴀᴛᴇ', date: { is_not_empty: true } };
  const queryBody = { filter: dateFilter };
  // Formula ᴅᴀᴛᴇ はソート可否が構成依存なので、通常の日付プロパティだけAPI側で降順にする。
  if (dateType === 'date') queryBody.sorts = [{ property: 'ᴅᴀᴛᴇ', direction: 'descending' }];
  const pages = await queryAll(dataSource.id, queryBody);
  const titleName = titlePropertyName(dataSource.schema);
  const out = [];

  for (const page of pages) {
    const dateProp = page.properties?.['ᴅᴀᴛᴇ'];
    const notionDate = dateProp?.type === 'formula'
      ? dateProp?.formula?.date
      : dateProp?.date;
    const date = datePartsFromNotion(notionDate?.start);
    const endDate = datePartsFromNotion(notionDate?.end);
    if (!date || date.month !== today.month || date.day !== today.day) continue;

    const title = pageTitle(page, titleName);
    if (!title) continue;

    const tags = [];
    for (const propName of SESSION_PERSON_PROPERTIES) {
      tags.push(...await propertyTexts(page.properties?.[propName]));
    }
    const hashtagText = unique(tags).map(name => `#${name}`).join(' ');
    const dateText = formatAnniversaryDate(date, endDate);
    const text = `${dateText} ${title}${hashtagText ? ` ${hashtagText}` : ''}`;

    out.push({
      text,
      url: pagePublicUrl(page, warnings, `ANNIVERSARY ${title}`),
      separatorBefore: '✧',
      year: date.year,
    });
  }

  out.sort((a, b) => b.year - a.year || a.text.localeCompare(b.text, 'ja'));
  return out.map(({ year, ...item }) => item);
}

async function main() {
  const warnings = [];
  const today = tokyoParts();

  const [cfDataSource, sessionDataSource, birthdayDataSource] = await Promise.all([
    findDataSource(DATABASES.cf),
    findDataSource(DATABASES.sessions),
    findDataSource(DATABASES.birthdays),
  ]);

  const items = [];
  items.push({ text: 'SARS LAND', url: '', separatorBefore: '' });
  items.push(await buildCfItem(cfDataSource, today));

  const birthdays = await buildBirthdayItems(birthdayDataSource, warnings);
  items.push({ text: 'BIRTHDAY', url: '', separatorBefore: '✦' });
  if (birthdays.length) {
    items.push(...birthdays);
  } else {
    items.push({
      text: '今日誕生日の探索者はいません',
      url: '',
      separatorBefore: '✧',
    });
  }

  const anniversaries = await buildAnniversaryItems(sessionDataSource, today, warnings);
  items.push({ text: "TODAY'S ANNIVERSARY", url: '', separatorBefore: '✦' });
  if (anniversaries.length) {
    items.push(...anniversaries);
  } else {
    items.push({
      text: '今日が記念日の卓報告はありません',
      url: '',
      separatorBefore: '✧',
    });
  }

  const output = {
    generatedAt: new Date().toISOString(),
    timeZone: TIME_ZONE,
    date: `${today.year}-${String(today.month).padStart(2, '0')}-${String(today.day).padStart(2, '0')}`,
    items,
    warnings,
  };

  await writeFile('news-feed.json', JSON.stringify(output, null, 2) + '\n', 'utf8');
  console.log(`news-feed.json を更新しました: ${items.length} items`);
  if (warnings.length) console.warn(warnings.join('\n'));
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
