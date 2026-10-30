import { expect, test } from 'vitest';
import {
  detectLanguage,
  saveLanguage,
  createTranslator,
  formatDate,
  readFailure,
  errorText,
} from '../packages/dashboard/ui/i18n-core.js';

test('manual preferences override ordered supported browser languages and storage failures are harmless', () => {
  expect(detectLanguage({ getItem: () => 'en' }, ['fr', 'zh-TW', 'en'])).toBe('en');
  expect(detectLanguage({ getItem: () => 'invalid' }, ['fr', 'zh-TW', 'en'])).toBe('zh-CN');
  expect(
    detectLanguage(
      {
        getItem: () => {
          throw Error();
        },
      },
      ['fr', 'en-GB'],
    ),
  ).toBe('en');
  expect(detectLanguage(null, undefined, 'zh-HK')).toBe('zh-CN');
  expect(detectLanguage(null, [], 'zh')).toBe('en');
});
test('translations interpolate complete sentences, fall back safely and keep foreign errors intact', () => {
  const t = createTranslator('zh-CN', { en: { greeting: 'Hello {name}' }, 'zh-CN': {} });
  expect(t('greeting', { name: 'Fleet A' })).toBe('Hello Fleet A');
  expect(t('absent')).toBe('absent');
  expect(errorText(readFailure(403), createTranslator('zh-CN'))).toContain('403');
  expect(errorText(new Error('original detail'), t)).toBe('original detail');
});
test('date presentation includes seconds and timezone while preserving invalid evidence', () => {
  expect(formatDate('bad evidence', 'zh-CN')).toBe('bad evidence');
  const value = formatDate('2026-10-30T12:34:56Z', 'en', 'UTC');
  expect(value).toContain('56');
  expect(value).toContain('UTC');
});

test('all translations have matching keys, named parameters and referenced literals', async () => {
  const { dictionaries } = await import('../packages/dashboard/ui/i18n-core.js');
  const { readdir, readFile } = await import('node:fs/promises');
  const { default: ts } = await import('typescript');
  const keys = Object.keys(dictionaries.en).sort();
  expect(Object.keys(dictionaries['zh-CN']).sort()).toEqual(keys);
  const parameters = (text: string) => [...text.matchAll(/\{(\w+)\}/g)].map((m) => m[1]).sort();
  for (const key of keys)
    expect(parameters(dictionaries['zh-CN'][key])).toEqual(parameters(dictionaries.en[key]));
  const ui = new URL('../packages/dashboard/ui/', import.meta.url);
  for (const file of await readdir(ui)) {
    if (!file.endsWith('.jsx')) continue;
    const source = await readFile(new URL(file, ui), 'utf8');
    for (const match of source.matchAll(/\bt\(['"]([^'"]+)['"]\s*[,)]/g))
      expect(keys, `${file}: ${match[1]}`).toContain(match[1]);
  }
  // TypeScript's parser exposes duplicate object properties even in JSX-excluded dictionaries.
  for (const file of await readdir(new URL('locales/', ui))) {
    const source = await readFile(new URL(`locales/${file}`, ui), 'utf8');
    const parsed = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
    const visit = (node: import('typescript').Node) => {
      if (ts.isObjectLiteralExpression(node)) {
        const names = node.properties
          .filter(ts.isPropertyAssignment)
          .map((property) => property.name.getText(parsed));
        expect(new Set(names).size, file).toBe(names.length);
      }
      ts.forEachChild(node, visit);
    };
    visit(parsed);
  }
});

test('automatic detection never persists while explicit choices tolerate failed writes', () => {
  const writes: string[] = [];
  const storage = {
    getItem: () => null,
    setItem: (_key: string, value: string) => {
      writes.push(value);
    },
  };
  expect(detectLanguage(storage, ['zh-SG'])).toBe('zh-CN');
  expect(writes).toEqual([]);
  saveLanguage(storage, 'en');
  expect(writes).toEqual(['en']);
  expect(() =>
    saveLanguage(
      {
        setItem: () => {
          throw Error('denied');
        },
      },
      'zh-CN',
    ),
  ).not.toThrow();
});
