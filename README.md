# Organizer Butler

Organizer Butler is a local-first, safety-constrained file organization core intended for use through a semantic MCP server. The AI agent reasons about classifications; Organizer Butler controls filesystem inspection, validation, planning, execution, audit history, and undo.

## Current milestone

The initial safe-core foundation provides:

- configuration with independently overridable inbox and organization roots;
- controlled area and document-type taxonomies;
- path-containment validation that handles similarly prefixed directories;
- non-recursive Downloads scanning;
- rejection of hidden, temporary, directory, and symlink entries;
- opaque, process-local file IDs with stale-file validation;
- structured errors with stable machine-readable codes;
- deterministic filename and extension rule evidence without classification;
- bounded TXT and Markdown inspection;
- dependency-free, streaming CSV inspection with bounded headers, sampled rows, columns, and fields;
- dependency-free JSON inspection with a bounded structural preview and explicit truncation flags;
- dependency-free ZIP central-directory inspection with bounded metadata and no extraction;
- safe rejection of malformed, encrypted, multi-disk, ZIP64, unsafe-name, and ambiguous-name archives;
- bounded PDF metadata inspection through the focused `pdf-lib` parser, with no text extraction or rendering;
- strict PDF metadata allowlisting and safe rejection of malformed, encrypted, unsupported-version, oversized, and over-object-limit documents;
- bounded XLSX workbook metadata inspection through the focused `saxes` XML parser, with no worksheet cell or embedded-content inspection;
- strict XLSX package and relationship validation with safe rejection of encrypted, macro-enabled, malformed, unsafe, duplicate, unsupported, and over-limit workbooks;
- bounded DOCX core-property inspection through the focused `saxes` XML parser, with no body or embedded-content inspection;
- strict DOCX package and relationship validation with safe rejection of encrypted, macro-enabled, malformed, unsafe, duplicate, unsupported, and over-limit documents;
- bounded PPTX presentation and core-property inspection through the focused `saxes` XML parser, with no slide or embedded-content inspection;
- strict PPTX package and relationship validation with safe rejection of encrypted, macro-enabled, malformed, unsafe, duplicate, unsupported, and over-limit presentations;
- safe malformed-CSV results and metadata-only fallback for unsupported formats;
- a thin scan-only CLI.

MCP tools, document body extraction, full spreadsheet data extraction, PDF text extraction, planning, mutation, SQLite history, and undo are not implemented yet.

## Development

```sh
npm install
npm test
npm run typecheck
```

Run the scanner against a synthetic directory, not personal files, during development:

```sh
ORGANIZER_DOWNLOADS_DIRECTORY=/path/to/fixture npm run organize
```

The scanner does not recurse and never moves or deletes files.

## Inspection limits

Inspection limits are explicit and configurable:

| Environment variable | Default | Purpose |
| --- | ---: | --- |
| `ORGANIZER_MAX_EXTRACTED_TEXT_LENGTH` | 6000 | Maximum Unicode characters retained from TXT or Markdown files |
| `ORGANIZER_MAX_CSV_SAMPLED_ROWS` | 20 | Maximum CSV data rows retained after the header |
| `ORGANIZER_MAX_CSV_COLUMNS` | 50 | Maximum fields retained from each CSV record |
| `ORGANIZER_MAX_CSV_FIELD_LENGTH` | 1000 | Maximum Unicode characters retained from each CSV field |
| `ORGANIZER_MAX_JSON_SOURCE_BYTES` | 1000000 | Maximum JSON source bytes accepted before parsing |
| `ORGANIZER_MAX_JSON_DEPTH` | 8 | Maximum nested JSON depth retained in the structural preview |
| `ORGANIZER_MAX_JSON_OBJECT_KEYS` | 50 | Maximum keys retained from each JSON object |
| `ORGANIZER_MAX_JSON_ARRAY_ITEMS` | 50 | Maximum items retained from each JSON array |
| `ORGANIZER_MAX_JSON_STRING_LENGTH` | 1000 | Maximum Unicode characters retained from JSON strings and object keys |
| `ORGANIZER_MAX_ZIP_ARCHIVE_SIZE` | 100000000 | Maximum ZIP file size in bytes accepted for metadata inspection |
| `ORGANIZER_MAX_ZIP_ENTRIES` | 1000 | Maximum number of ZIP central-directory entries accepted |
| `ORGANIZER_MAX_ZIP_FILENAME_LENGTH` | 512 | Maximum encoded filename length in bytes for each ZIP entry |
| `ORGANIZER_MAX_ZIP_METADATA_READ` | 1000000 | Maximum central-directory metadata bytes read and retained |
| `ORGANIZER_MAX_PDF_SOURCE_BYTES` | 10000000 | Maximum PDF source bytes accepted before allocation and parsing |
| `ORGANIZER_MAX_PDF_OBJECTS` | 100000 | Maximum parsed indirect PDF objects accepted |
| `ORGANIZER_MAX_PDF_METADATA_FIELDS` | 6 | Maximum allowlisted document-info fields retained |
| `ORGANIZER_MAX_PDF_METADATA_STRING_LENGTH` | 1000 | Maximum Unicode characters retained from each PDF metadata value |
| `ORGANIZER_MAX_XLSX_SOURCE_BYTES` | 50000000 | Maximum XLSX source bytes accepted before allocation and package parsing |
| `ORGANIZER_MAX_XLSX_PACKAGE_ENTRIES` | 2000 | Maximum XLSX ZIP package entries accepted |
| `ORGANIZER_MAX_XLSX_COMPRESSED_METADATA_BYTES` | 1000000 | Maximum aggregate compressed bytes for required XLSX metadata parts |
| `ORGANIZER_MAX_XLSX_UNCOMPRESSED_METADATA_BYTES` | 5000000 | Maximum aggregate uncompressed bytes for required XLSX metadata parts |
| `ORGANIZER_MAX_XLSX_WORKSHEETS` | 1000 | Maximum worksheet declarations accepted before metadata retention |
| `ORGANIZER_MAX_XLSX_RETAINED_SHEET_NAMES` | 100 | Maximum sheet names retained in workbook order |
| `ORGANIZER_MAX_XLSX_SHEET_NAME_LENGTH` | 128 | Maximum Unicode characters retained from each sheet name |
| `ORGANIZER_MAX_DOCX_SOURCE_BYTES` | 50000000 | Maximum DOCX source bytes accepted before allocation and package parsing |
| `ORGANIZER_MAX_DOCX_PACKAGE_ENTRIES` | 2000 | Maximum DOCX ZIP package entries accepted |
| `ORGANIZER_MAX_DOCX_COMPRESSED_METADATA_BYTES` | 1000000 | Maximum aggregate compressed bytes for required DOCX metadata parts |
| `ORGANIZER_MAX_DOCX_UNCOMPRESSED_METADATA_BYTES` | 5000000 | Maximum aggregate uncompressed bytes for required DOCX metadata parts |
| `ORGANIZER_MAX_DOCX_METADATA_FIELDS` | 6 | Maximum allowlisted DOCX core-property fields retained |
| `ORGANIZER_MAX_DOCX_METADATA_STRING_LENGTH` | 1000 | Maximum Unicode characters retained from each DOCX metadata value |
| `ORGANIZER_MAX_PPTX_SOURCE_BYTES` | 50000000 | Maximum PPTX source bytes accepted before allocation and package parsing |
| `ORGANIZER_MAX_PPTX_PACKAGE_ENTRIES` | 2000 | Maximum PPTX ZIP package entries accepted |
| `ORGANIZER_MAX_PPTX_COMPRESSED_METADATA_BYTES` | 1000000 | Maximum aggregate compressed bytes for required PPTX metadata parts |
| `ORGANIZER_MAX_PPTX_UNCOMPRESSED_METADATA_BYTES` | 5000000 | Maximum aggregate uncompressed bytes for required PPTX metadata parts |
| `ORGANIZER_MAX_PPTX_SLIDES` | 1000 | Maximum slide declarations accepted |
| `ORGANIZER_MAX_PPTX_METADATA_FIELDS` | 6 | Maximum allowlisted PPTX core-property fields retained |
| `ORGANIZER_MAX_PPTX_METADATA_STRING_LENGTH` | 1000 | Maximum Unicode characters retained from each PPTX metadata value |

CSV inspection streams the complete file so quoting is validated and the total number of data rows is counted. It retains only the configured header columns and sampled rows. The result reports whether rows, columns, or fields were truncated. Empty files return empty headers and rows; header-only files return no sampled rows. Invalid quoting returns `MALFORMED_CSV` without exposing partial parsed content.

JSON inspection checks the source-byte limit before reading the document into memory, validates the complete bounded source with a dependency-free parser, and returns a tagged structural preview. Numbers are retained as source lexemes to avoid precision loss. Preview limits apply independently to depth, object keys, array items, and Unicode string characters; object keys use the string limit too. Explicit flags report every retained-content truncation. Empty containers and scalar roots are valid. Malformed syntax returns `MALFORMED_JSON`, excessive parser nesting returns `JSON_NESTING_TOO_DEEP`, and invalid UTF-8 is treated as malformed JSON, all without source snippets or partial content. Duplicate decoded keys, including escape-equivalent keys, are rejected as `DUPLICATE_OBJECT_KEY` rather than silently applying last-key-wins behavior.

ZIP inspection reads the bounded end-of-central-directory search region and central directory only. It never reads, decompresses, or extracts entry content. Successful output lists entry names, directory flags, compressed and uncompressed sizes, and compression method numbers. Archives that exceed a configured limit or use unsupported or unsafe structures return a structured rejection without partial entry metadata. Entry-name checks treat both `/` and `\` as path separators and reject traversal, absolute paths, empty path components, dot components, NULs, undecodable names, and separator-equivalent duplicates.

PDF inspection uses the focused `pdf-lib` dependency rather than an ad hoc partial parser. The source-byte limit is checked before allocating or parsing the complete document. PDF versions 1.0 through 1.7 are accepted; other versions return `UNSUPPORTED_PDF_FEATURE`. Encrypted PDFs are identified from the parsed trailer and rejected before page or metadata access, without attempting decryption. The parsed indirect-object count is checked before metadata is retained. Successful output contains only the PDF version, page count, `encrypted: false`, and a deterministic allowlist of document-info fields: title, author, subject, keywords, creator, and producer. Arbitrary custom fields, dates, XMP packets, attachments, JavaScript, page content, and parser internals are never returned. Metadata field and Unicode string limits report explicit truncation flags. A structurally valid zero-page PDF is accepted with `pageCount: 0`, following the parser's valid-document semantics. Malformed, encrypted, unsupported-version, source-limit, and object-limit results contain no partial metadata or parser exception text.

XLSX inspection treats each workbook as a constrained ZIP/OPC package and uses the focused, namespace-aware `saxes` parser for bounded XML metadata. It validates the complete central directory before XML parsing, rejects unsafe or duplicate part names, and reads only `[Content_Types].xml`, root relationships, the resolved workbook declaration, and its relationships. Every required part is protected by aggregate compressed and uncompressed limits, bounded deflate output, size verification, and CRC verification. Relationships must remain internal, may not traverse, and must resolve to expected workbook or worksheet part types. Successful output contains only `workbookFormat: "xlsx"`, total sheet count, bounded names in workbook order, and explicit retained-name and string truncation flags. Worksheet XML, cells, formulas, comments, images, macros, external links, embedded files, document properties, and custom properties are not read or returned. Encrypted, macro-enabled, malformed, unsupported, unsafe, duplicate, and configured-limit results contain no partial workbook metadata.

DOCX inspection treats each document as a separate constrained ZIP/OPC format and uses the same focused, namespace-aware XML dependency without exposing generic archive metadata. It validates the complete central directory, content types, the root office-document relationship, and optional document relationships. It reads only `[Content_Types].xml`, root relationships, optional document relationships, and optional core properties; `word/document.xml` is required but never decompressed. Required metadata parts have aggregate compressed and uncompressed limits, bounded deflate output, size verification, and CRC verification. Successful output contains only `documentFormat: "docx"` and a deterministic allowlist of title, subject, creator, keywords, description, and last-modified-by core properties, with independent field and Unicode string truncation flags. Body text, comments, revisions, images, macros, external links, embedded files, custom properties, relationship targets, package entry names, and parser details are not returned. Encrypted, macro-enabled, malformed, unsupported, unsafe, duplicate, and configured-limit results contain no partial document metadata.

PPTX inspection treats each presentation as a separate constrained ZIP/OPC format without exposing generic archive metadata. It validates the complete central directory, content types, the root office-document relationship, the resolved presentation declaration, and presentation relationships. It reads only `[Content_Types].xml`, root relationships, `ppt/presentation.xml`, its relationships, and optional core properties; declared slide parts are required but never decompressed. Required metadata parts have aggregate compressed and uncompressed limits, bounded deflate output, size verification, and CRC verification. Successful output contains only `presentationFormat: "pptx"`, the total slide count, and a deterministic allowlist of title, subject, creator, keywords, description, and last-modified-by core properties, with independent field and Unicode string truncation flags. Slide text, notes, comments, images, videos, macros, external links, embedded files, custom properties, relationship targets, package entry names, and parser details are not read or returned. Encrypted, macro-enabled, malformed, unsupported, unsafe, duplicate, and configured-limit results contain no partial presentation metadata.

All inspection still starts and ends with resolution through the same long-lived `FileRegistry`. Public results contain the opaque `fileId` and metadata, never a raw filesystem path. Inspection provides content and rule signals only; it does not classify, choose a destination, or mutate files.

## Next-session handoff

Current state:

1. The safe core supports non-recursive scanning and opaque process-local file IDs.
2. Structured errors use `OrganizerError`; inspections resolve exclusively through a supplied long-lived `FileRegistry` and validate files before and after inspection, including parser failures.
3. Centralized deterministic rules return ordered `RuleEvidence[]` signals only; they do not classify, choose destinations, plan, or mutate.
4. TXT and Markdown receive bounded text extraction.
5. CSV receives dependency-free streaming inspection with bounded headers, sampled rows, columns, and fields; complete quoting validation; total row counts; explicit truncation flags; and safe malformed results.
6. JSON receives dependency-free bounded structural previews with source, depth, object-key, array-item, and string limits; scalar and empty roots; preserved number lexemes; duplicate-key rejection; and safe malformed or nesting-limit results.
7. ZIP receives dependency-free bounded central-directory inspection without extraction or decompression, with explicit limit, encryption, malformed, multi-disk, ZIP64, unsafe-name, and ambiguous-name rejections.
8. PDF receives bounded read-only metadata inspection through `src/core/inspector/inspectPdf.ts` and the focused `pdf-lib` dependency.
9. PDF source size is checked before full allocation and parsing with `maxPdfSourceBytes`; oversized documents return `PDF_SOURCE_TOO_LARGE`.
10. PDF parser work is bounded after parsing by `maxPdfObjects`; over-limit documents return `PDF_OBJECT_LIMIT_EXCEEDED` before metadata retention.
11. PDF output contains only version, page count, `encrypted: false`, and allowlisted title, author, subject, keywords, creator, and producer fields.
12. PDF metadata fields and Unicode values are bounded independently with `maxPdfMetadataFields` and `maxPdfMetadataStringLength`, with explicit field and string truncation flags.
13. PDF versions 1.0 through 1.7 are accepted. Other versions return `UNSUPPORTED_PDF_FEATURE` without parsing metadata.
14. Structurally valid zero-page PDFs return successful metadata with `pageCount: 0`.
15. Encrypted PDFs return `ENCRYPTED_PDF` before page or metadata access and are not decrypted.
16. Malformed PDFs return `MALFORMED_PDF` without parser exception text, source snippets, object content, or partial metadata.
17. PDF inspection does not extract text, OCR, render, inspect page content, expose XMP/custom metadata, extract attachments, execute JavaScript, or mutate files.
18. XLSX receives bounded read-only workbook metadata inspection through `src/core/inspector/inspectXlsx.ts` and the focused, namespace-aware `saxes` XML parser.
19. XLSX source size and package entry count are checked before workbook XML parsing with `maxXlsxSourceBytes` and `maxXlsxPackageEntries`.
20. Only content types, root relationships, the resolved workbook declaration, and workbook relationships are decompressed; worksheet cell XML and arbitrary package metadata are never read.
21. Required metadata parts are bounded by aggregate compressed and uncompressed limits, bounded deflate output, declared-size verification, and CRC verification.
22. XLSX output contains only `workbookFormat: "xlsx"`, total sheet count, sheet names in workbook order, and explicit retained-name and Unicode string truncation flags.
23. XLSX worksheet declarations and output are bounded independently with `maxXlsxWorksheets`, `maxXlsxRetainedSheetNames`, and `maxXlsxSheetNameLength`.
24. XLSX relationship resolution normalizes internal targets, rejects absolute, external, encoded or literal traversal, URI, query, fragment, and backslash targets, and requires expected workbook and worksheet relationship types.
25. Encrypted, macro-enabled, malformed, unsupported-feature, unsafe-entry-name, unsafe-relationship, duplicate-part, and configured-limit XLSX packages return explicit structured reasons without partial metadata.
26. XLSX inspection does not extract cells, formulas, comments, images, macros, external links, embedded files, document properties, or custom properties.
27. DOCX receives bounded read-only core-property inspection through `src/core/inspector/inspectDocx.ts` and the focused, namespace-aware `saxes` XML parser.
28. DOCX source size and package entry count are checked before metadata XML parsing with `maxDocxSourceBytes` and `maxDocxPackageEntries`.
29. Only content types, root relationships, optional document relationships, and optional core properties are decompressed; `word/document.xml` body content and arbitrary package metadata are never read.
30. Required DOCX metadata parts are bounded by aggregate compressed and uncompressed limits, bounded deflate output, declared-size verification, and CRC verification.
31. DOCX output contains only `documentFormat: "docx"` and allowlisted title, subject, creator, keywords, description, and last-modified-by fields.
32. DOCX metadata fields and Unicode values are bounded independently with `maxDocxMetadataFields` and `maxDocxMetadataStringLength`, with explicit field and string truncation flags.
33. DOCX relationship resolution rejects absolute, external, encoded or literal traversal, URI, query, fragment, and backslash targets, and validates supported relationship types without exposing targets.
34. Encrypted, macro-enabled, malformed, unsupported-feature, unsafe-entry-name, unsafe-relationship, duplicate-part, and configured-limit DOCX packages return explicit structured reasons without partial metadata.
35. DOCX inspection does not extract body text, comments, revisions, images, macros, external links, embedded files, custom properties, or arbitrary package metadata.
36. PPTX receives bounded read-only presentation metadata inspection through `src/core/inspector/inspectPptx.ts` and the focused, namespace-aware `saxes` XML parser.
37. PPTX source size and package entry count are checked before presentation XML parsing with `maxPptxSourceBytes` and `maxPptxPackageEntries`.
38. Only content types, root relationships, the resolved presentation declaration, presentation relationships, and optional core properties are decompressed; slide XML and arbitrary package metadata are never read.
39. Required PPTX metadata parts are bounded by aggregate compressed and uncompressed limits, bounded deflate output, declared-size verification, and CRC verification.
40. PPTX output contains only `presentationFormat: "pptx"`, total slide count, and allowlisted title, subject, creator, keywords, description, and last-modified-by fields.
41. PPTX slide declarations, metadata fields, and Unicode values are bounded independently with `maxPptxSlides`, `maxPptxMetadataFields`, and `maxPptxMetadataStringLength`, with explicit field and string truncation flags.
42. PPTX relationship resolution rejects absolute, external, encoded or literal traversal, URI, query, fragment, and backslash targets, and validates supported relationship types without exposing targets.
43. Encrypted, macro-enabled, malformed, unsupported-feature, unsafe-entry-name, unsafe-relationship, duplicate-part, and configured-limit PPTX packages return explicit structured reasons without partial metadata.
44. PPTX inspection does not extract slide text, notes, comments, images, videos, macros, external links, embedded files, custom properties, or arbitrary package metadata.
45. Other formats return metadata and rule evidence with `UNSUPPORTED_FORMAT`.
46. Inspection output never exposes raw filesystem paths.
47. Temporary-directory PPTX tests use compact generated fixtures and cover empty and multiple-slide presentations; allowlisted metadata; all seven configured limits; non-ASCII truncation; malformed ZIP, presentation XML, and metadata XML; encrypted, macro-enabled, and unsupported packages; unsafe entries and relationships; duplicate and missing parts; omitted slide and custom-property content; path omission; rule evidence; and files changed after scanning.
48. `.env.example` documents CSV, JSON, ZIP, PDF, XLSX, DOCX, and PPTX inspection limits.
49. `npm test` passes 82 tests and `npm run typecheck` passes as of this increment.
50. No MCP, SQLite, slide text extraction, document body extraction, full spreadsheet data extraction, archive extraction to disk, PDF content extraction, planning, classification decisions, or mutation exists.

Recommended next increment:

1. Implement bounded, read-only image metadata inspection as a separate increment for JPEG and PNG; do not decode pixels, OCR, render, transform, or mutate images.
2. Define explicit source-byte, dimension, metadata-field, and metadata-string limits before implementation, including a safe maximum pixel count derived from declared dimensions without allocating an image buffer.
3. Prefer dependency-free parsing of the narrow JPEG marker and PNG chunk structures; add a focused dependency only if it demonstrably improves validation without decoding image content.
4. Return only format, dimensions, and a minimal explicit allowlist of low-risk metadata; omit GPS coordinates, thumbnails, maker notes, comments, profiles, arbitrary EXIF, and raw chunk or marker data.
5. Reject malformed, unsupported-feature, invalid-dimension, oversized-source, excessive-pixel-count, excessive-segment/chunk, and configured-limit cases with explicit structured reasons and no partial image metadata.
6. For JPEG, bound marker traversal, reject arithmetic coding and unsupported structures, validate segment lengths, and inspect only the minimum SOF and allowlisted metadata segments.
7. For PNG, validate the signature, chunk framing, ordering, length bounds, and CRCs; inspect only IHDR and explicitly allowlisted textual metadata, without inflating IDAT image data.
8. Do not expose arbitrary segment names, chunk names, binary payloads, parser details, source snippets, or filesystem paths.
9. Preserve the supplied long-lived `FileRegistry` boundary and validation before and after inspection, including parser failures.
10. Keep image inspection as content and rule evidence only; do not classify, choose a destination, plan, or mutate files.
11. Add compact generated temporary-directory fixtures for minimal JPEG and PNG images, dimensions, allowlisted metadata, non-ASCII truncation, every configured limit, malformed lengths and CRCs, unsupported features, omitted pixel and private metadata content, path omission, and files changed after scanning.
12. Do not check in large binary samples or use personal image content.
13. Run `npm test` and `npm run typecheck`, then update the test count and every new environment variable in this README and `.env.example`.
14. Do not add MCP, SQLite, OCR, pixel decoding, image mutation, slide text extraction, document body extraction, archive extraction to disk, full spreadsheet data extraction, PDF text extraction, planning, classification decisions, or mutation in the image increment.
