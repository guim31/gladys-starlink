// -----------------------------------------------------------------------------
// Every text Gladys shows exists in the four languages of its interface
// (English, French, German, Spanish): the manifest, the message tables of the
// code, the feature names, and the four documentation files, which share
// their sections. German says "du", never the polite "Sie".
// -----------------------------------------------------------------------------

import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { LANGUAGES } from '../src/config.js';
import { ALERTS, NAMES, SNOW_MELT, STATES, TEXT, WIDGET_TEXT } from '../src/i18n.js';
import { FEATURE } from '../src/dish.js';
import { OUTAGE_CAUSES } from '../src/starlink/schema.js';

const manifest = JSON.parse(
  await readFile(new URL('../gladys-assistant-integration.json', import.meta.url), 'utf8'),
);

const LANGS = ['en', 'fr', 'de', 'es'];
const POLITE_GERMAN = /(?<!\p{L})(Sie|Ihr|Ihre|Ihren|Ihrem|Ihrer|Ihres)(?!\p{L})/u;

// Upper bounds, in characters: what the Gladys interface shows without cutting.
const MAX = {
  catalog: 100,
  widgetLabel: 30,
  label: 60,
  placeholder: 60,
  description: 300,
  message: 200,
  short: 24,
  featureName: 40,
  state: 40,
};

const sorted = (keys) => [...keys].sort();

/** Checks one multi-language object; returns its problems. */
function problems(value, path, max) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return [`${path} must be a multi-language object`];
  }
  const found = [];
  if (JSON.stringify(sorted(Object.keys(value))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${path} has [${Object.keys(value)}], expected exactly [${LANGS}]`);
  }
  for (const [lang, text] of Object.entries(value)) {
    found.push(...textProblems(text, `${path}.${lang}`, lang, max));
  }
  return found;
}

function textProblems(text, path, lang, max) {
  if (typeof text !== 'string' || text.trim() === '') {
    return [`${path} is empty`];
  }
  const found = [];
  if (text.length > max) {
    found.push(`${path} has ${text.length} characters (${max} at most)`);
  }
  if (lang === 'de' && POLITE_GERMAN.test(text)) {
    found.push(`${path} uses the polite form: "${text}"`);
  }
  return found;
}

/** Every multi-language object of the manifest, with its length limit. */
function manifestTexts(root) {
  const texts = [];
  const walk = (value, path, key) => {
    if (Array.isArray(value)) {
      value.forEach((item, index) => walk(item, `${path}[${index}]`, key));
      return;
    }
    if (!value || typeof value !== 'object') {
      return;
    }
    const isText =
      ['label', 'description', 'placeholder'].includes(key) ||
      Object.keys(value).some((child) => LANGS.includes(child));
    if (isText) {
      // The store schema caps the catalog and widget descriptions, and widget labels.
      const max =
        path === 'manifest.description' || /^manifest\.widgets\[\d+\]\.description$/.test(path)
          ? MAX.catalog
          : /^manifest\.widgets\[\d+\]\.label$/.test(path)
            ? MAX.widgetLabel
            : (MAX[key] ?? MAX.label);
      texts.push({ path, value, max });
      return;
    }
    for (const [child, item] of Object.entries(value)) {
      walk(item, `${path}.${child}`, child);
    }
  };
  walk(root, 'manifest', null);
  return texts;
}

// Tables written one language at a time: same keys everywhere, no empty text.
function tableProblems(table, name, max, render = (value) => value) {
  const found = [];
  if (JSON.stringify(sorted(Object.keys(table))) !== JSON.stringify(sorted(LANGS))) {
    found.push(`${name} has [${Object.keys(table)}], expected exactly [${LANGS}]`);
  }
  for (const lang of LANGS) {
    const entries = table[lang] ?? {};
    if (
      JSON.stringify(sorted(Object.keys(entries))) !== JSON.stringify(sorted(Object.keys(table.en)))
    ) {
      found.push(`${name}.${lang} does not have the keys of ${name}.en`);
    }
    for (const [key, value] of Object.entries(entries)) {
      found.push(...textProblems(render(value), `${name}.${lang}.${key}`, lang, max));
    }
  }
  return found;
}

test('the configuration offers the four languages', () => {
  assert.deepEqual(LANGUAGES, LANGS);
  const field = manifest.config_schema.find((f) => f.key === 'language');
  assert.deepEqual(
    field.options.map((option) => option.value),
    LANGS,
  );
  assert.equal(field.default, 'fr');
});

test('every text of the manifest is in English, French, German and Spanish', () => {
  const texts = manifestTexts(manifest);
  assert.ok(texts.length >= 65, `only ${texts.length} texts found in the manifest`);
  const found = texts.flatMap(({ path, value, max }) => problems(value, path, max));
  assert.deepEqual(found, []);
});

test('the name is the brand, the same in every language', () => {
  assert.equal(manifest.name, 'Starlink');
  assert.ok(manifest.name.length >= 3 && manifest.name.length <= 30);
});

test('the catalog description holds 10 to 100 characters in every language', () => {
  for (const lang of LANGS) {
    assert.ok(manifest.description[lang].length >= 10, `description.${lang} is too short`);
  }
});

test('the feature names exist in every language, for every feature', () => {
  assert.deepEqual(tableProblems(NAMES, 'NAMES', MAX.featureName), []);
  assert.deepEqual(sorted(Object.keys(NAMES.en)), sorted(Object.values(FEATURE)));
});

test('every dish state has a label in every language', () => {
  assert.deepEqual(tableProblems(STATES, 'STATES', MAX.state), []);
  for (const cause of [...Object.values(OUTAGE_CAUSES), 'connected', 'unreachable']) {
    assert.ok(STATES.en[cause], `no label for the state ${cause}`);
  }
});

test('the snow melt modes, alerts and widget texts exist in every language', () => {
  assert.deepEqual(tableProblems(SNOW_MELT, 'SNOW_MELT', MAX.short), []);
  assert.deepEqual(tableProblems(ALERTS, 'ALERTS', MAX.state), []);
  const render = (value) => (typeof value === 'function' ? value(12) : value);
  const long = new Set(['waiting', 'notConfigured']);
  const found = tableProblems(WIDGET_TEXT, 'WIDGET_TEXT', MAX.message, render).concat(
    LANGS.flatMap((lang) =>
      Object.entries(WIDGET_TEXT[lang])
        .filter(([key]) => !long.has(key))
        .flatMap(([key, value]) =>
          textProblems(render(value), `WIDGET_TEXT.${lang}.${key}`, lang, MAX.short),
        ),
    ),
  );
  assert.deepEqual(found, []);
});

test('every message of the code has the four languages', () => {
  const samples = {
    invalidHost: ['300.1.1.1'],
    unreachable: ['192.168.100.1:9200', 'no answer within 5 s'],
    publishFailed: ['400 BAD_REQUEST'],
    found: [{ hardware: 'rev3_proto2', software: '2026.09.1', state: STATES.en }],
    snowMeltSet: ['always_on'],
    commandFailed: ['gRPC UNIMPLEMENTED'],
  };
  const found = Object.entries(TEXT).flatMap(([key, build]) => {
    const value = build(...(samples[key] ?? []));
    // The address or the version can be long: a little more room than a toast.
    return problems(value, `TEXT.${key}`, MAX.message + 60);
  });
  assert.deepEqual(found, []);
  assert.match(TEXT.found(samples.found[0]).fr, /Antenne trouvée/);
});

/** The `##` headings of a documentation file. */
async function sections(lang) {
  const text = await readFile(new URL(`../docs/${lang}.md`, import.meta.url), 'utf8');
  return { text, headings: [...text.matchAll(/^## (.+)$/gm)].map((match) => match[1]) };
}

test('the four documentation files exist, with the same sections in the same order', async () => {
  const docs = Object.fromEntries(
    await Promise.all(LANGS.map(async (l) => [l, await sections(l)])),
  );
  const count = docs.en.headings.length;
  assert.ok(count >= 8, `docs/en.md has only ${count} sections`);
  for (const lang of LANGS) {
    assert.equal(docs[lang].headings.length, count, `docs/${lang}.md: ${docs[lang].headings}`);
    assert.ok(docs[lang].text.length >= 300, `docs/${lang}.md is too short for the store`);
    assert.ok(!POLITE_GERMAN.test(lang === 'de' ? docs.de.text : ''), 'docs/de.md says "Sie"');
  }
  // Same structure: the same number of ### subsections under each section.
  const sub = (text) => text.split(/^## /m).map((part) => (part.match(/^### /gm) ?? []).length);
  for (const lang of LANGS) {
    assert.deepEqual(sub(docs[lang].text), sub(docs.en.text), `docs/${lang}.md subsections`);
  }
  // Every scene trigger, scene action and action key is documented everywhere.
  const keys = [
    ...manifest.scene_triggers,
    ...manifest.scene_actions,
    ...manifest.actions,
    ...manifest.widgets,
  ].map((entry) => entry.key);
  for (const lang of LANGS) {
    for (const key of keys) {
      assert.ok(docs[lang].text.includes(key), `docs/${lang}.md does not mention ${key}`);
    }
  }
});

test('the guard catches a missing language, an empty text and the polite German form', () => {
  assert.equal(problems({ en: 'Dish', fr: 'Antenne', de: 'Antenne' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'Dish', fr: 'Antenne', de: '', es: 'Antena' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a', es: 'a', it: 'a' }, 'x', 60).length, 1);
  assert.equal(problems({ en: 'a', fr: 'a', de: 'a'.repeat(61), es: 'a' }, 'x', 60).length, 1);
  for (const polite of ['Wählen Sie', 'Ihr Gerät', 'Ihre IP', 'mit Ihrem', 'Ihren', 'Ihrer']) {
    assert.equal(problems({ en: 'a', fr: 'a', de: polite, es: 'a' }, 'x', 60).length, 1, polite);
  }
  // Words that only contain the letters stay allowed.
  assert.deepEqual(
    problems({ en: 'a', fr: 'a', de: 'Sieh dir ihre Daten an', es: 'a' }, 'x', 60),
    [],
  );
  // A manifest text forgotten in German is found.
  const forgotten = structuredClone(manifest);
  delete forgotten.scene_actions[0].label.de;
  const found = manifestTexts(forgotten).flatMap(({ path, value, max }) =>
    problems(value, path, max),
  );
  assert.deepEqual(found, [
    'manifest.scene_actions[0].label has [en,fr,es], expected exactly [en,fr,de,es]',
  ]);
});
