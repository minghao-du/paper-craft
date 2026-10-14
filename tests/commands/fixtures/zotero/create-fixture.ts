/**
 * Generate minimal Zotero + Better BibTeX SQLite fixture databases.
 *
 * Run with: pnpm exec tsx tests/commands/fixtures/zotero/create-fixture.ts
 *
 * Creates:
 *   - zotero.sqlite          — core Zotero schema with two test items
 *   - better-bibtex-search.sqlite — BBT citekey mapping
 */

import initSqlJs from 'sql.js';
import { writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function main() {
  const SQL = await initSqlJs();

  // --- Zotero database ---
  const zotero = new SQL.Database();

  // Minimal Zotero schema (only tables we query)
  zotero.run(`
    CREATE TABLE items (
      itemID INTEGER PRIMARY KEY,
      itemTypeID INTEGER NOT NULL,
      libraryID INTEGER NOT NULL DEFAULT 1,
      key TEXT NOT NULL
    )
  `);

  zotero.run(`
    CREATE TABLE itemTypes (
      itemTypeID INTEGER PRIMARY KEY,
      typeName TEXT NOT NULL
    )
  `);

  zotero.run(`
    CREATE TABLE fields (
      fieldID INTEGER PRIMARY KEY,
      fieldName TEXT NOT NULL
    )
  `);

  zotero.run(`
    CREATE TABLE itemData (
      itemID INTEGER NOT NULL,
      fieldID INTEGER NOT NULL,
      valueID INTEGER NOT NULL,
      PRIMARY KEY (itemID, fieldID)
    )
  `);

  zotero.run(`
    CREATE TABLE itemDataValues (
      valueID INTEGER PRIMARY KEY,
      value TEXT NOT NULL
    )
  `);

  zotero.run(`
    CREATE TABLE creators (
      creatorID INTEGER PRIMARY KEY,
      firstName TEXT,
      lastName TEXT
    )
  `);

  zotero.run(`
    CREATE TABLE itemCreators (
      itemID INTEGER NOT NULL,
      creatorID INTEGER NOT NULL,
      creatorTypeID INTEGER NOT NULL,
      orderIndex INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (itemID, creatorID, creatorTypeID, orderIndex)
    )
  `);

  zotero.run(`
    CREATE TABLE deletedItems (
      itemID INTEGER PRIMARY KEY
    )
  `);

  zotero.run(`
    CREATE TABLE tags (
      tagID INTEGER PRIMARY KEY,
      name TEXT NOT NULL UNIQUE
    )
  `);

  zotero.run(`
    CREATE TABLE itemTags (
      itemID INTEGER NOT NULL,
      tagID INTEGER NOT NULL,
      type INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (itemID, tagID)
    )
  `);

  zotero.run(`
    CREATE TABLE collections (
      collectionID INTEGER PRIMARY KEY,
      collectionName TEXT NOT NULL,
      parentCollectionID INTEGER,
      libraryID INTEGER NOT NULL DEFAULT 1,
      key TEXT NOT NULL
    )
  `);

  zotero.run(`
    CREATE TABLE collectionItems (
      collectionID INTEGER NOT NULL,
      itemID INTEGER NOT NULL,
      orderIndex INTEGER NOT NULL DEFAULT 0,
      PRIMARY KEY (collectionID, itemID)
    )
  `);

  // Populate itemTypes
  zotero.run(`INSERT INTO itemTypes VALUES (2, 'journalArticle')`);
  zotero.run(`INSERT INTO itemTypes VALUES (4, 'conferencePaper')`);
  zotero.run(`INSERT INTO itemTypes VALUES (14, 'attachment')`);
  zotero.run(`INSERT INTO itemTypes VALUES (36, 'annotation')`);
  zotero.run(`INSERT INTO itemTypes VALUES (1, 'note')`);

  // Populate fields
  const fields = [
    [1, 'title'],
    [3, 'abstractNote'],
    [4, 'volume'],
    [5, 'issue'],
    [6, 'pages'],
    [12, 'DOI'],
    [14, 'date'],
    [15, 'publicationTitle'],
  ] as const;
  for (const [id, name] of fields) {
    zotero.run(`INSERT INTO fields VALUES (?, ?)`, [id, name]);
  }

  // --- Item 1: journal article ---
  zotero.run(`INSERT INTO items VALUES (1, 2, 1, 'ABC12345')`);

  // Data values for item 1
  const values1 = [
    [1, 'Attention Is All You Need'],
    [2, 'We propose a new simple network architecture, the Transformer.'],
    [3, '30'],
    [4, ''],
    [5, '5998-6008'],
    [6, '10.5555/3295222.3295349'],
    [7, '2017-06-12'],
    [8, 'Advances in Neural Information Processing Systems'],
  ] as const;
  for (const [id, val] of values1) {
    zotero.run(`INSERT INTO itemDataValues VALUES (?, ?)`, [id, val]);
  }

  // Field mappings for item 1
  const itemData1 = [
    [1, 1, 1], // title
    [1, 3, 2], // abstractNote
    [1, 4, 3], // volume
    [1, 5, 4], // issue (empty)
    [1, 6, 5], // pages
    [1, 12, 6], // DOI
    [1, 14, 7], // date
    [1, 15, 8], // publicationTitle (venue)
  ] as const;
  for (const [itemID, fieldID, valueID] of itemData1) {
    zotero.run(`INSERT INTO itemData VALUES (?, ?, ?)`, [itemID, fieldID, valueID]);
  }

  // Creators for item 1
  zotero.run(`INSERT INTO creators VALUES (1, 'Ashish', 'Vaswani')`);
  zotero.run(`INSERT INTO creators VALUES (2, 'Noam', 'Shazeer')`);
  zotero.run(`INSERT INTO itemCreators VALUES (1, 1, 1, 0)`);
  zotero.run(`INSERT INTO itemCreators VALUES (1, 2, 1, 1)`);

  // --- Item 2: conference paper ---
  zotero.run(`INSERT INTO items VALUES (2, 4, 1, 'DEF67890')`);

  const values2 = [
    [9, 'BERT: Pre-training of Deep Bidirectional Transformers'],
    [10, 'We introduce a new language representation model called BERT.'],
    [11, ''],
    [12, ''],
    [13, '4171-4186'],
    [14, '10.18653/v1/N19-1423'],
    [15, '2019'],
    [16, 'NAACL-HLT'],
  ] as const;
  for (const [id, val] of values2) {
    zotero.run(`INSERT INTO itemDataValues VALUES (?, ?)`, [id, val]);
  }

  const itemData2 = [
    [2, 1, 9], // title
    [2, 3, 10], // abstractNote
    [2, 4, 11], // volume (empty)
    [2, 5, 12], // issue (empty)
    [2, 6, 13], // pages
    [2, 12, 14], // DOI
    [2, 14, 15], // date
    [2, 15, 16], // publicationTitle (venue)
  ] as const;
  for (const [itemID, fieldID, valueID] of itemData2) {
    zotero.run(`INSERT INTO itemData VALUES (?, ?, ?)`, [itemID, fieldID, valueID]);
  }

  // Creators for item 2
  zotero.run(`INSERT INTO creators VALUES (3, 'Jacob', 'Devlin')`);
  zotero.run(`INSERT INTO itemCreators VALUES (2, 3, 1, 0)`);

  // --- Item 3: a deleted item (should be excluded) ---
  zotero.run(`INSERT INTO items VALUES (3, 2, 1, 'GHI11111')`);
  zotero.run(`INSERT INTO deletedItems VALUES (3)`);

  // --- Item 4: an attachment (should be excluded from main results) ---
  zotero.run(`INSERT INTO items VALUES (4, 14, 1, 'ATT00001')`);

  // --- Item 5: a note (should be excluded from main results) ---
  zotero.run(`INSERT INTO items VALUES (5, 1, 1, 'NOTE0001')`);

  // --- Item 6: group library item (libraryID = 2) ---
  zotero.run(`INSERT INTO items VALUES (6, 2, 2, 'GRP12345')`);

  const values6 = [
    [17, 'Language Models are Few-Shot Learners'],
    [18, 'We demonstrate that scaling up language models greatly improves task-agnostic, few-shot performance.'],
    [19, '33'],
    [20, ''],
    [21, '1877-1901'],
    [22, '10.5555/3495724.3495883'],
    [23, '2020-05-28'],
    [24, 'Advances in Neural Information Processing Systems'],
  ] as const;
  for (const [id, val] of values6) {
    zotero.run(`INSERT INTO itemDataValues VALUES (?, ?)`, [id, val]);
  }

  const itemData6 = [
    [6, 1, 17], // title
    [6, 3, 18], // abstractNote
    [6, 4, 19], // volume
    [6, 5, 20], // issue (empty)
    [6, 6, 21], // pages
    [6, 12, 22], // DOI
    [6, 14, 23], // date
    [6, 15, 24], // publicationTitle (venue)
  ] as const;
  for (const [itemID, fieldID, valueID] of itemData6) {
    zotero.run(`INSERT INTO itemData VALUES (?, ?, ?)`, [itemID, fieldID, valueID]);
  }

  // Creators for item 6
  zotero.run(`INSERT INTO creators VALUES (4, 'Tom', 'Brown')`);
  zotero.run(`INSERT INTO itemCreators VALUES (6, 4, 1, 0)`);

  // --- Tags ---
  zotero.run(`INSERT INTO tags VALUES (1, 'deep-learning')`);
  zotero.run(`INSERT INTO tags VALUES (2, 'transformer')`);
  zotero.run(`INSERT INTO tags VALUES (3, 'few-shot')`);
  zotero.run(`INSERT INTO tags VALUES (4, 'llm')`);

  // Item 1 has tags 'deep-learning' and 'transformer'
  zotero.run(`INSERT INTO itemTags VALUES (1, 1, 0)`);
  zotero.run(`INSERT INTO itemTags VALUES (1, 2, 0)`);

  // Item 6 (group library) has tags 'few-shot' and 'llm'
  zotero.run(`INSERT INTO itemTags VALUES (6, 3, 0)`);
  zotero.run(`INSERT INTO itemTags VALUES (6, 4, 0)`);
  // Note: Item 2 has NO tags

  // --- Collections ---
  zotero.run(`INSERT INTO collections VALUES (1, 'Artificial Intelligence', NULL, 1, 'COLL0001')`);
  zotero.run(`INSERT INTO collections VALUES (2, 'Deep Learning Hierarchy', 1, 1, 'COLL0002')`);
  zotero.run(`INSERT INTO collectionItems VALUES (2, 1, 0)`); // item 1 in collection 2
  zotero.run(`INSERT INTO collectionItems VALUES (1, 2, 0)`); // item 2 in collection 1

  // Write zotero.sqlite
  const zoteroData = zotero.export();
  await writeFile(join(__dirname, 'zotero.sqlite'), Buffer.from(zoteroData));
  zotero.close();

  // --- Better BibTeX database ---
  const bbt = new SQL.Database();

  bbt.run(`
    CREATE TABLE citekeys (
      itemID INTEGER NOT NULL,
      itemKey TEXT NOT NULL,
      libraryID INTEGER NOT NULL DEFAULT 1,
      citekey TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0
    )
  `);

  bbt.run(`INSERT INTO citekeys VALUES (1, 'ABC12345', 1, 'vaswani2017attention', 1)`);
  bbt.run(`INSERT INTO citekeys VALUES (2, 'DEF67890', 1, 'devlin2019bert', 1)`);
  // Deleted item also has a citekey (should be filtered out by the query)
  bbt.run(`INSERT INTO citekeys VALUES (3, 'GHI11111', 1, 'deleted2020paper', 1)`);
  // Group library item citekey
  bbt.run(`INSERT INTO citekeys VALUES (6, 'GRP12345', 2, 'brown2020language', 1)`);

  const bbtData = bbt.export();
  await writeFile(join(__dirname, 'better-bibtex-search.sqlite'), Buffer.from(bbtData));
  bbt.close();

  console.log('Fixtures created successfully.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
