// A fast drop-in replacement for csv-reader 1.0.0.
//
// It returns exactly the reference reader's answer for every input:
// {columns, rows, errors} for {text, header}, under the same broken-row
// policy. In my own words, that policy is:
//
// - A U+FEFF at the very start of the text is dropped.
// - A record ends at LF or CRLF; a line left with no characters is no
//   record. Outside quotes, a CR not followed by LF is dropped and logged
//   as stray_cr.
// - A field that opens with a quote runs to the next quote that is not
//   doubled ("" inside it is one quote); each CRLF or lone CR inside it
//   reads as LF. What follows the closing quote, up to the next comma or
//   line break, is appended as it stands (quote_junk, when the field
//   ends). A quote that never closes is a literal character and the text
//   after it is read again as unquoted (unterminated_quote).
// - A quote inside an unquoted field is a literal character. Fields stay
//   strings, never trimmed or converted.
// - columns is the first record when header is true, else null; rows holds
//   the records after it (every record when header is false), each padded
//   with "" (short_row, with fields: its field count) or cut (long_row,
//   with extra: the cut fields) to the first record's width.
// - Each error is {code, line, row}, in the order met: line the 1-based
//   line its record starts on (counting every LF, CRLF and lone CR inside
//   a quoted field), row its record's index in rows (null for the header);
//   a field's quote_junk when the field ends, a record's short_row or
//   long_row when the record ends.
//
// The engine differs from the reference: instead of building every field
// one character at a time, it takes fields as slices of the input string
// wherever the text allows it. A record that holds no quote and no stray
// CR is split in one call; an unquoted field is found by jumping to its
// next comma or line break. Only a field that spans line breaks inside
// quotes, holds doubled quotes, carries junk after its closing quote, or
// is split by a stray CR takes a slower path. Nothing is kept from one
// call to the next.

const COMMA = 0;
const BREAK = 1;
const END = 2;

// Scan one unquoted field starting at `from`, with `head` (null, or an
// array of string pieces already kept for this field) in front of it.
// Returns [value, ended, pos, lineDelta], where lineDelta is 1 when the
// field ended at a line break, else 0. Records stray_cr errors as met.
// Used for the rare unquoted re-reads: junk after a closing quote and the
// re-read of an unterminated quote, and for an unquoted field that holds
// a stray CR. The common unquoted field is inlined in run() below so it
// pays no call.
function scanTail(text, len, errors, from, head, recLine, recRow) {
  let start = from;
  let s = from;
  let parts = head;
  while (true) {
    if (s >= len) {
      const value = parts === null ? text.slice(start, s) : parts.join('') + text.slice(start, s);
      return [value, END, s, 0];
    }
    const c = text.charCodeAt(s);
    if (c === 44) {
      const value = parts === null ? text.slice(start, s) : parts.join('') + text.slice(start, s);
      return [value, COMMA, s + 1, 0];
    }
    if (c === 10) {
      const value = parts === null ? text.slice(start, s) : parts.join('') + text.slice(start, s);
      return [value, BREAK, s + 1, 1];
    }
    if (c === 13) {
      if (s + 1 < len && text.charCodeAt(s + 1) === 10) {
        const value = parts === null ? text.slice(start, s) : parts.join('') + text.slice(start, s);
        return [value, BREAK, s + 2, 1];
      }
      errors.push({ code: 'stray_cr', line: recLine, row: recRow });
      if (parts === null) parts = [];
      parts.push(text.slice(start, s));
      s += 1;
      start = s;
      continue;
    }
    s += 1;
  }
}

/** csv-reader 1.0.0's answer for one case's input. */
export function run(input) {
  const text = String(input.text);
  const header = input.header === true;
  const len = text.length;
  const errors = [];
  const rows = [];
  let columns = null;
  let width = -1;
  let pos = 0;
  let line = 1;
  if (len > 0 && text.charCodeAt(0) === 0xFEFF) pos = 1;

  outer: while (true) {
    // Lines with no characters are no records.
    while (pos < len) {
      const c = text.charCodeAt(pos);
      if (c === 10) {
        pos += 1;
        line += 1;
      } else if (c === 13 && pos + 1 < len && text.charCodeAt(pos + 1) === 10) {
        pos += 2;
        line += 1;
      } else {
        break;
      }
    }
    if (pos >= len) break;

    const recordLine = line;
    const recordRow = header && columns === null ? null : rows.length;
    let fields;
    let lastQuoted = false;

    // Fast path: the whole record is one line holding no quote and no
    // stray CR (a trailing CR right before its LF is the CRLF ending).
    // Such a record is split in one call and carries no errors.
    const lf = text.indexOf('\n', pos);
    const lineEnd = lf === -1 ? len : lf;
    const seg = text.slice(pos, lineEnd);
    let fast = false;
    if (seg.indexOf('"') === -1) {
      const crAt = seg.indexOf('\r');
      if (crAt === -1) {
        fields = seg.split(',');
        pos = lf === -1 ? len : lf + 1;
        if (lf !== -1) line += 1;
        fast = true;
      } else if (lf !== -1 && crAt === seg.length - 1) {
        fields = seg.slice(0, -1).split(',');
        pos = lf + 1;
        line += 1;
        fast = true;
      }
    }

    // The next LF at or after the record's start (len when there is
    // none): the record's line end, while no field has swallowed a line
    // break inside quotes. It stays valid because every other way a
    // field ends (comma, or a line break that ends the record) swallows
    // no LF; after a quoted field that does hold an LF it is re-found.
    let recLf = lf === -1 ? len : lf;

    if (!fast) {
      fields = [];
      let value = '';
      let ended = COMMA;

      while (true) {
        if (text.charCodeAt(pos) === 34) {
          // ----- a field that opens with a quote -----
          lastQuoted = true;
          const open = pos;
          const openLine = line;
          let searchFrom = pos + 1;
          let close = -1;
          let doubled = false;
          for (;;) {
            const q = text.indexOf('"', searchFrom);
            if (q === -1) break;
            if (q + 1 < len && text.charCodeAt(q + 1) === 34) {
              doubled = true;
              searchFrom = q + 2;
              continue;
            }
            close = q;
            break;
          }
          if (close === -1) {
            // The quote never closes: it is a literal character, and the
            // text after it is read again as unquoted.
            errors.push({ code: 'unterminated_quote', line: recordLine, row: recordRow });
            line = openLine;
            const r = scanTail(text, len, errors, open + 1, ['"'], recordLine, recordRow);
            value = r[0];
            ended = r[1];
            pos = r[2];
            line += r[3];
          } else {
            // Whether the span holds a line break: recLf is the first LF
            // at or after the record's start, so one before the closing
            // quote is inside the span.
            const hasNl = recLf < close;
            const span = text.slice(pos + 1, close);
            if (!hasNl && span.indexOf('\r') === -1) {
              value = doubled ? span.replaceAll('""', '"') : span;
            } else {
              // Newlines and/or doubled quotes inside: walk just this
              // span, folding each CRLF or lone CR to one LF and each ""
              // to one ".
              const parts = [];
              let segStart = pos + 1;
              let i = pos + 1;
              while (i < close) {
                const c = text.charCodeAt(i);
                if (c === 34) {
                  parts.push(text.slice(segStart, i));
                  parts.push('"');
                  i += 2;
                  segStart = i;
                } else if (c === 13) {
                  parts.push(text.slice(segStart, i));
                  parts.push('\n');
                  line += 1;
                  i += i + 1 < close && text.charCodeAt(i + 1) === 10 ? 2 : 1;
                  segStart = i;
                } else {
                  if (c === 10) line += 1;
                  i += 1;
                }
              }
              parts.push(text.slice(segStart, close));
              value = parts.join('');
            }
            const after = close + 1;
            if (after >= len) {
              pos = len;
              ended = END;
            } else {
              const c = text.charCodeAt(after);
              if (c === 44) {
                pos = after + 1;
                ended = COMMA;
              } else if (c === 10) {
                pos = after + 1;
                line += 1;
                ended = BREAK;
              } else if (c === 13 && after + 1 < len && text.charCodeAt(after + 1) === 10) {
                pos = after + 2;
                line += 1;
                ended = BREAK;
              } else {
                // What follows the closing quote is appended as it
                // stands, up to the next comma or line break.
                const r = scanTail(text, len, errors, after, [value], recordLine, recordRow);
                if (r[0].length > value.length) {
                  errors.push({ code: 'quote_junk', line: recordLine, row: recordRow });
                }
                value = r[0];
                ended = r[1];
                pos = r[2];
                line += r[3];
              }
            }
            // A quoted field that swallowed line breaks moved the
            // record's line end: re-find it for the fields that follow.
            if (hasNl && ended === COMMA) {
              recLf = text.indexOf('\n', pos);
              if (recLf === -1) recLf = len;
            }
          }
        } else {
          // ----- an unquoted field: jump to its next comma or line break -----
          // The line break is recLf, already known; only the comma is
          // still to find.
          lastQuoted = false;
          const comma = text.indexOf(',', pos);
          let end;
          let ended2;
          if (comma !== -1 && comma < recLf) {
            end = comma;
            ended2 = COMMA;
          } else if (recLf < len) {
            end = recLf;
            ended2 = BREAK;
          } else {
            end = len;
            ended2 = END;
          }
          // A CR right before the line break is the CRLF ending, not
          // part of the field.
          let stop = end;
          if (ended2 === BREAK && end > pos && text.charCodeAt(end - 1) === 13) stop = end - 1;
          const cand = text.slice(pos, stop);
          if (cand.indexOf('\r') === -1) {
            value = cand;
            ended = ended2;
            pos = ended === END ? len : end + 1;
            if (ended === BREAK) line += 1;
          } else {
            // Rare: a stray CR inside the field; walk it a character
            // at a time, dropping each stray CR.
            const r = scanTail(text, len, errors, pos, null, recordLine, recordRow);
            value = r[0];
            ended = r[1];
            pos = r[2];
            line += r[3];
          }
        }
        fields.push(value);
        if (ended !== COMMA) break;
      }

      // A line that held only stray CRs is left with no characters: no
      // record (its stray_cr errors stay).
      if (fields.length === 1 && fields[0] === '' && !lastQuoted) continue outer;
    }

    if (width < 0) width = fields.length;
    if (header && columns === null) {
      columns = fields;
      continue outer;
    }
    if (fields.length < width) {
      errors.push({ code: 'short_row', line: recordLine, row: recordRow, fields: fields.length });
      while (fields.length < width) fields.push('');
    } else if (fields.length > width) {
      errors.push({ code: 'long_row', line: recordLine, row: recordRow, extra: fields.splice(width) });
    }
    rows.push(fields);
  }
  return { columns: header ? (columns ?? []) : null, rows, errors };
}
