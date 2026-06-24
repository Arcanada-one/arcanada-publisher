# LinkedIn label fixtures (PUB-0031 / PUB-0032)

Captured **control labels** from the real LinkedIn UI so the selector regexes can
be tested against the actual strings LinkedIn ships — offline, in CI, with zero
publishing. This closes the gap the hand-built fake page in the unit tests cannot:
when LinkedIn localizes or renames a control, the fixture's recorded label fails
the matching regex the same way the live flow would, but without a browser.

We deliberately do NOT store full HTML dumps: they carry PII (name, headline,
message previews), need redaction, and require a DOM lib (jsdom) the package does
not depend on. The flows match controls by **accessible name / text**, so the
label is the part that actually drifts — and the label is what we record.

## Format

Each `*.labels.json` is:

```json
{
  "source": "real | synthetic",
  "capturedAt": "2026-06-24",
  "locale": "de-DE",
  "controls": {
    "postControlMenu": ["Mehr Aktionen"],
    "deleteMenuItem": ["Beitrag löschen"],
    "confirmDelete": ["Löschen"],
    "commentBox": ["Kommentar hinzufügen"]
  }
}
```

`tests/dom-fixtures.test.ts` asserts every recorded label matches the
corresponding selector regex. A NEW label that does not match is exactly the
drift we want CI to catch.

## How to capture real labels (operator, ~1 min, no posting)

In a logged-in session, with the composer / post menu open, run in devtools:

```js
copy(JSON.stringify({
  postControlMenu: [...document.querySelectorAll('button[aria-label]')]
    .map(b => b.getAttribute('aria-label'))
    .filter(l => /menu|aktion|action|меню/i.test(l)),
  // …repeat for the Delete item, Confirm button, comment box…
}, null, 2));
```

Save as e.g. `de-2026.labels.json` with `"source": "real"` and the locale. No
redaction needed — these are LinkedIn's own UI strings, not your content.
