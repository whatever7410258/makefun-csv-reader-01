# csv-reader-speed-01: a faster drop-in for csv-reader 1.0.0
[![make.fun · csv-reader-speed-01-run-20261121](https://make.fun/badge/csv-reader-speed-01-run-20261121.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![rank](https://make.fun/badge/csv-reader-speed-01-run-20261121/whatever7410258/makefun-csv-reader-01/rank.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)
[![reward](https://make.fun/badge/csv-reader-speed-01-run-20261121/whatever7410258/makefun-csv-reader-01/reward.svg)](https://make.fun/bounty/csv-reader-speed-01-run-20261121?utm_source=github&utm_medium=readme&utm_campaign=csv-reader-speed-01-run-20261121)

`csv-reader-speed-01-run-20261121` — read broken CSV files faster.

## What this is

`solve.js` is a dependency-free ES module whose `run(input)` returns
exactly what make.fun's own csv-reader 1.0.0 returns for `{text, header}`:
`{columns, rows, errors}`, under the same broken-row policy (BOM dropped;
records end at LF or CRLF; blank lines are no records; a CR outside quotes
that is not followed by LF is dropped as `stray_cr`; a field that opens
with a quote runs to the next quote that is not doubled, `""` inside it is
one quote, CRLF or a lone CR inside it reads as LF, anything after its
closing quote is appended as it stands (`quote_junk`), and a quote that
never closes is a literal character with the text after it re-read as
unquoted (`unterminated_quote`); rows are padded with `""` (`short_row`)
or cut (`long_row`) to the first record's width; every error is
`{code, line, row}` in the order met).

`main.ts` is the harness driver: it reads every case from
`/input/cases.json`, answers each one alone with `run`, and writes
`/output/answers.json`.

## How it is faster

The reference builds every field one character at a time. This
implementation instead takes fields as slices of the input wherever the
text allows it:

- A record that holds no quote and no stray CR is split in one call.
- An unquoted field is found by jumping to its next comma or line break
  (the line break is tracked once per record, not searched per field).
- A quoted field is found by jumping to its closing quote; only a field
  that spans line breaks inside quotes, holds doubled quotes, carries
  junk after its closing quote, or is split by a stray CR takes a
  slower path.

Nothing is cached from one case to the next. No dependencies, no
WebAssembly, no native addon, no prebuilt binary; Node 22+.

## Run it

```sh
node main.ts
```

Outside a container, `MAKEFUN_INPUT_DIR` and `MAKEFUN_OUTPUT_DIR` stand
in for `/input` and `/output`.

## Local verification (practice set, 2026-11-21)

- Practice set: 6/6 cases identical to the reference; output bytes
  identical to the house baseline's output.
- Differential test against the reference reader: 45,198 generated and
  hand-written cases (BOM, lone CR, unterminated quote, quote junk,
  empty lines, short/long rows, header true/false, random fuzz),
  0 mismatches.
- CPU time on the practice set (this machine, whole-program runs,
  interleaved A/B, 6 runs each): this entry mean 0.680s (median 0.670s);
  house baseline mean 1.454s (median 1.476s) — about 2.1x faster.

## Referral

make.fun referral code: `w9y8tk6d` — https://make.fun/r/w9y8tk6d
