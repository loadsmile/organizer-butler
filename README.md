# Organizer Butler

Organizer Butler is a local-first, safety-constrained file organization core intended for use through a semantic MCP server. The AI agent reasons about classifications; Organizer Butler controls filesystem inspection, validation, planning, explicit confirmation, durable directory creation, and file-move execution.

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
- bounded XLSX workbook metadata and scalar cell previews through the focused `saxes` XML parser, with exact number lexemes and no formula interpretation or embedded-content inspection;
- strict XLSX package and relationship validation with safe rejection of encrypted, macro-enabled, malformed, unsafe, duplicate, unsupported, and over-limit workbooks;
- bounded DOCX core-property and direct body-paragraph inspection through the focused `saxes` XML parser, with no embedded-content inspection;
- strict DOCX package and relationship validation with safe rejection of encrypted, macro-enabled, malformed, unsafe, duplicate, unsupported, and over-limit documents;
- bounded PPTX presentation, core-property, and direct shape-text inspection through the focused `saxes` XML parser, with no embedded-content inspection;
- strict PPTX package and relationship validation with safe rejection of encrypted, macro-enabled, malformed, unsafe, duplicate, unsupported, and over-limit presentations;
- a shared bounded OOXML package reader for XLSX, DOCX, and PPTX that validates central and local ZIP declarations, member boundaries, decompression limits, declared sizes, and CRCs;
- shared low-level OPC XML primitives for strict UTF-8 decoding, XML policy, namespace-aware attributes, content-type and relationship envelopes, relationship-part naming, and internal target normalization;
- dependency-free, bounded JPEG and PNG metadata inspection without pixel decoding, decompression, rendering, OCR, or transformation;
- strict JPEG marker and PNG chunk validation with safe rejection of malformed, unsupported, invalid-dimension, oversized, excessive-pixel, and over-structure-limit images;
- safe malformed-CSV results and metadata-only fallback for unsupported formats;
- a strict stdio MCP server with schema-validated scan, inspection, preview, confirmation, controlled-directory creation, and file-move tools;
- one process-long `FileRegistry` shared across all calls handled by an MCP server instance;
- sanitized structured MCP failures that preserve `OrganizerError` codes without paths, stack traces, or parser details;
- strict provider-independent validation of host-submitted classifications against the controlled taxonomies;
- an MCP preview workflow that freshly reinspects opaque IDs, copies trusted rule evidence, mints a process-local classification capability, and performs no network request;
- deterministic preview-only organization planning through process-local validated-classification and opaque-plan capabilities, explicit taxonomy directory mappings, stale-file validation, safe destination checks, and collision reporting;
- explicit one-time plan confirmation through independently expiring process-local confirmation capabilities, with confirmation-time source and destination revalidation and no filesystem mutation;
- startup-integrated durable execution records, exclusive same-filesystem hard-link/unlink moves, coordinated crash recovery, strict MCP execution, and lost-response replay through SQLite;
- separately confirmed, durable creation of missing controlled destination directories, with exclusive one-level creation, identity-pinned recovery, and conservative rollback;
- versioned SQLite migrations, owner-scoped recovery leases, bounded terminal-record retention, and graceful shutdown that waits for active operations;
- a thin scan-only CLI.

Full spreadsheet data extraction, PDF text extraction, broad user-facing audit history, and undo are not implemented. The scanner and organizer intentionally handle regular files only; directories and macOS application bundles are excluded.

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

Run the stdio MCP server against a synthetic fixture directory:

```sh
ORGANIZER_DOWNLOADS_DIRECTORY=/path/to/fixture npm run mcp
```

The scanner does not recurse. The MCP server moves a file only through the preview, explicit confirmation, and execution capability sequence. Do not point development sessions at directories containing personal files.

## MCP tools

The MCP server exposes these narrow tools:

| Tool | Input | Output |
| --- | --- | --- |
| `scan_files` | Strict empty object | `{ ok: true, files }` with non-recursive file metadata and opaque process-local IDs, or a sanitized structured error |
| `inspect_file` | Strict `{ fileId: string }` | `{ ok: true, inspection }` with bounded extraction and ordered rule evidence, or `{ ok: false, error }` preserving a stable `OrganizerError` code |
| `submit_classification_and_preview_file` | Strict `{ fileId, classification: { area, documentType, rationale } }` | `{ ok: true, plan }` with one process-local plan ID, controlled destination display segments, filename, and conflict state, or a sanitized structured error |
| `preview_organization_directories` | Strict `{ planId: string }` | `{ ok: true, directoryPlan }` with a separate process-local directory plan and controlled segment statuses, or a sanitized structured error |
| `confirm_organization_directories` | Strict `{ directoryPlanId: string }` | `{ ok: true, confirmation }` with separate durable directory-creation authority, or a sanitized structured error |
| `execute_organization_directories` | Strict `{ directoryConfirmationId: string }` | `{ ok: true, execution }` after exclusive one-level controlled directory creation, or a sanitized structured error |
| `confirm_organization_plan` | Strict `{ planId: string }` | `{ ok: true, confirmation }` with one process-local confirmation ID, bound plan and file IDs, and expiry, or a sanitized structured error |
| `execute_organization_plan` | Strict `{ confirmationId: string }` | `{ ok: true, execution }` with the confirmation, plan, and file IDs plus `status: "completed"`, or a sanitized structured error |

No tool accepts a path. File and plan IDs remain process-local. `submit_classification_and_preview_file` freshly inspects the opaque file ID, accepts only controlled taxonomy values and a bounded rationale, derives the file ID and rule evidence from that inspection, and passes the exact registered classification capability directly to planning. It accepts no serialized inspection, evidence, destination, model setting, or credential and performs no network request. Confirmation authority is persisted before return, so an exact confirmation ID can be executed or replayed after restart without caller-supplied authority. `confirm_organization_plan` revalidates and persists one expiring confirmation without filesystem mutation. `execute_organization_plan` requires explicit prior preview and confirmation and performs only an exclusive same-filesystem hard-link followed by source unlink into a pre-existing controlled directory. It never overwrites, merges, automatically renames, creates directories, or falls back to copy-and-delete.

## Inspection limits

Inspection limits are explicit and configurable:

| Environment variable | Default | Purpose |
| --- | ---: | --- |
| `ORGANIZER_DOWNLOADS_DIRECTORY` | `~/Downloads` | Non-recursive inbox scanned for regular files |
| `ORGANIZER_ROOT` | `~/Downloads` | Root containing controlled organization destinations |
| `ORGANIZER_DATABASE_PATH` | `~/.local/share/organizer-butler/actions.db` | SQLite database for durable confirmation, recovery, replay, and retention state |
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
| `ORGANIZER_MAX_XLSX_COMPRESSED_METADATA_BYTES` | 1000000 | Maximum aggregate compressed bytes for selected XLSX metadata and preview parts |
| `ORGANIZER_MAX_XLSX_UNCOMPRESSED_METADATA_BYTES` | 5000000 | Maximum aggregate uncompressed bytes for selected XLSX metadata and preview parts |
| `ORGANIZER_MAX_XLSX_WORKSHEETS` | 1000 | Maximum worksheet declarations accepted before metadata retention |
| `ORGANIZER_MAX_XLSX_RETAINED_SHEET_NAMES` | 100 | Maximum sheet names retained in workbook order |
| `ORGANIZER_MAX_XLSX_SHEET_NAME_LENGTH` | 128 | Maximum Unicode characters retained from each sheet name |
| `ORGANIZER_MAX_XLSX_WORKSHEET_PARTS` | 1000 | Maximum validated worksheet parts traversed in workbook order |
| `ORGANIZER_MAX_XLSX_RETAINED_SHEETS` | 100 | Maximum worksheet previews retained in workbook order |
| `ORGANIZER_MAX_XLSX_ROWS_PER_SHEET` | 100 | Maximum sparse row previews retained per worksheet |
| `ORGANIZER_MAX_XLSX_CELLS_PER_ROW` | 100 | Maximum supported scalar cells retained per row |
| `ORGANIZER_MAX_XLSX_CHARACTERS` | 6000 | Maximum Unicode characters retained across XLSX scalar previews |
| `ORGANIZER_MAX_XLSX_SHARED_STRING_STRUCTURES` | 100000 | Maximum XML elements visited in the validated shared-string part |
| `ORGANIZER_MAX_XLSX_WORKSHEET_STRUCTURES` | 100000 | Maximum XML elements visited across all validated worksheet parts |
| `ORGANIZER_MAX_DOCX_SOURCE_BYTES` | 50000000 | Maximum DOCX source bytes accepted before allocation and package parsing |
| `ORGANIZER_MAX_DOCX_PACKAGE_ENTRIES` | 2000 | Maximum DOCX ZIP package entries accepted |
| `ORGANIZER_MAX_DOCX_COMPRESSED_METADATA_BYTES` | 1000000 | Maximum aggregate compressed bytes for required DOCX metadata parts |
| `ORGANIZER_MAX_DOCX_UNCOMPRESSED_METADATA_BYTES` | 5000000 | Maximum aggregate uncompressed bytes for required DOCX metadata parts |
| `ORGANIZER_MAX_DOCX_METADATA_FIELDS` | 6 | Maximum allowlisted DOCX core-property fields retained |
| `ORGANIZER_MAX_DOCX_METADATA_STRING_LENGTH` | 1000 | Maximum Unicode characters retained from each DOCX metadata value |
| `ORGANIZER_MAX_DOCX_BODY_PARTS` | 1 | Maximum DOCX body source parts traversed; only the validated main document part is supported |
| `ORGANIZER_MAX_DOCX_BODY_CHARACTERS` | 6000 | Maximum Unicode characters retained across the DOCX body preview |
| `ORGANIZER_MAX_DOCX_BODY_PARAGRAPHS` | 100 | Maximum direct body paragraphs retained in the DOCX preview |
| `ORGANIZER_MAX_DOCX_BODY_STRUCTURES` | 100000 | Maximum XML elements visited while validating the main DOCX body part |
| `ORGANIZER_MAX_PPTX_SOURCE_BYTES` | 50000000 | Maximum PPTX source bytes accepted before allocation and package parsing |
| `ORGANIZER_MAX_PPTX_PACKAGE_ENTRIES` | 2000 | Maximum PPTX ZIP package entries accepted |
| `ORGANIZER_MAX_PPTX_COMPRESSED_METADATA_BYTES` | 1000000 | Maximum aggregate compressed bytes for required PPTX metadata parts |
| `ORGANIZER_MAX_PPTX_UNCOMPRESSED_METADATA_BYTES` | 5000000 | Maximum aggregate uncompressed bytes for required PPTX metadata parts |
| `ORGANIZER_MAX_PPTX_SLIDES` | 1000 | Maximum slide declarations accepted |
| `ORGANIZER_MAX_PPTX_METADATA_FIELDS` | 6 | Maximum allowlisted PPTX core-property fields retained |
| `ORGANIZER_MAX_PPTX_METADATA_STRING_LENGTH` | 1000 | Maximum Unicode characters retained from each PPTX metadata value |
| `ORGANIZER_MAX_PPTX_SLIDE_PARTS` | 1000 | Maximum validated slide parts traversed in presentation order |
| `ORGANIZER_MAX_PPTX_RETAINED_SLIDES` | 100 | Maximum slide previews retained in presentation order |
| `ORGANIZER_MAX_PPTX_SLIDE_CHARACTERS` | 6000 | Maximum Unicode characters retained across all PPTX slide previews |
| `ORGANIZER_MAX_PPTX_TEXT_BLOCKS_PER_SLIDE` | 100 | Maximum DrawingML text-body paragraphs retained per slide |
| `ORGANIZER_MAX_PPTX_SLIDE_STRUCTURES` | 100000 | Maximum XML elements visited across all validated slide parts |
| `ORGANIZER_MAX_IMAGE_SOURCE_BYTES` | 50000000 | Maximum JPEG or PNG source bytes accepted before allocation and parsing |
| `ORGANIZER_MAX_IMAGE_DIMENSION` | 32768 | Maximum declared image width or height accepted in pixels |
| `ORGANIZER_MAX_IMAGE_PIXELS` | 100000000 | Maximum declared width times height accepted without allocating pixels |
| `ORGANIZER_MAX_IMAGE_STRUCTURES` | 10000 | Maximum JPEG markers or PNG chunks traversed |
| `ORGANIZER_MAX_IMAGE_METADATA_FIELDS` | 4 | Maximum allowlisted image metadata fields retained |
| `ORGANIZER_MAX_IMAGE_METADATA_STRING_LENGTH` | 1000 | Maximum Unicode characters retained from each image metadata value |
| `ORGANIZER_MAX_PLAN_PATH_BYTES` | 4096 | Maximum UTF-8 bytes allowed in an internally validated proposed destination path |
| `ORGANIZER_PLAN_EXPIRY_MS` | 600000 | Maximum lifetime of a process-local plan before confirmation |
| `ORGANIZER_CONFIRMATION_EXPIRY_MS` | 300000 | Lifetime of the separate process-local confirmation capability |
| `ORGANIZER_DIRECTORY_PLAN_EXPIRY_MS` | 600000 | Lifetime of a separate controlled-directory preview capability |
| `ORGANIZER_DIRECTORY_CONFIRMATION_EXPIRY_MS` | 300000 | Lifetime of durable controlled-directory creation authority |
| `ORGANIZER_INVALIDATED_EXECUTION_RETENTION_MS` | 2592000000 | Retention horizon for invalidated terminal move and directory records |
| `ORGANIZER_EXPIRED_EXECUTION_RETENTION_MS` | 2592000000 | Retention horizon for expired terminal move and directory records |
| `ORGANIZER_COMPLETED_EXECUTION_REPLAY_RETENTION_MS` | 31536000000 | Retention horizon for completed-result replay authority |
| `ORGANIZER_EXECUTION_RECOVERY_LEASE_MS` | 30000 | Owner-scoped recovery lease duration for interrupted durable operations |

CSV inspection streams the complete file so quoting is validated and the total number of data rows is counted. It retains only the configured header columns and sampled rows. The result reports whether rows, columns, or fields were truncated. Empty files return empty headers and rows; header-only files return no sampled rows. Invalid quoting returns `MALFORMED_CSV` without exposing partial parsed content.

JSON inspection checks the source-byte limit before reading the document into memory, validates the complete bounded source with a dependency-free parser, and returns a tagged structural preview. Numbers are retained as source lexemes to avoid precision loss. Preview limits apply independently to depth, object keys, array items, and Unicode string characters; object keys use the string limit too. Explicit flags report every retained-content truncation. Empty containers and scalar roots are valid. Malformed syntax returns `MALFORMED_JSON`, excessive parser nesting returns `JSON_NESTING_TOO_DEEP`, and invalid UTF-8 is treated as malformed JSON, all without source snippets or partial content. Duplicate decoded keys, including escape-equivalent keys, are rejected as `DUPLICATE_OBJECT_KEY` rather than silently applying last-key-wins behavior.

ZIP inspection reads the bounded end-of-central-directory search region and central directory only. It never reads, decompresses, or extracts entry content. Successful output lists entry names, directory flags, compressed and uncompressed sizes, and compression method numbers. Archives that exceed a configured limit or use unsupported or unsafe structures return a structured rejection without partial entry metadata. Entry-name checks treat both `/` and `\` as path separators and reject traversal, absolute paths, empty path components, dot components, NULs, undecodable names, and separator-equivalent duplicates.

PDF inspection uses the focused `pdf-lib` dependency rather than an ad hoc partial parser. The source-byte limit is checked before allocating or parsing the complete document. PDF versions 1.0 through 1.7 are accepted; other versions return `UNSUPPORTED_PDF_FEATURE`. Encrypted PDFs are identified from the parsed trailer and rejected before page or metadata access, without attempting decryption. The parsed indirect-object count is checked before metadata is retained. Successful output contains only the PDF version, page count, `encrypted: false`, and a deterministic allowlist of document-info fields: title, author, subject, keywords, creator, and producer. Arbitrary custom fields, dates, XMP packets, attachments, JavaScript, page content, and parser internals are never returned. Metadata field and Unicode string limits report explicit truncation flags. A structurally valid zero-page PDF is accepted with `pageCount: 0`, following the parser's valid-document semantics. Malformed, encrypted, unsupported-version, source-limit, and object-limit results contain no partial metadata or parser exception text. Bounded PDF text inspection was evaluated and intentionally not implemented: `pdf-lib` 1.17.1 exposes decoded stream bytes but provides no content-stream parser, text extraction API, `ToUnicode`/CMap reader, or font-to-Unicode decoder, and its stream decoding API has no caller-supplied decoded-output bound. Meeting the required complete-validation contract would therefore require a new PDF operator, stream, CMap, and font parser or a broader dependency, neither of which is introduced implicitly.

XLSX inspection treats each workbook as a constrained ZIP/OPC package and uses the focused, namespace-aware `saxes` parser for bounded metadata and scalar previews. It validates the complete central directory before XML parsing, rejects unsafe or duplicate part names, and reads only `[Content_Types].xml`, root relationships, the resolved workbook declaration, workbook relationships, validated worksheet parts in workbook order, and at most one validated shared-string part. Every selected part is protected by aggregate compressed and uncompressed limits, per-member bounded deflate output, local-to-central declaration checks, central-directory boundary checks, declared-size verification, and CRC verification. Relationships must remain internal, may not traverse, and must resolve to expected workbook, worksheet, or shared-string part types and content types. Successful output contains `workbookFormat: "xlsx"`, total sheet count, bounded names in workbook order, and deterministic sparse sheet, row, and cell previews. The deliberately supported cell subset is exact source number lexemes, booleans, plain inline strings, and plain shared strings. Formula cells and cached formula values are omitted; errors, dates, rich strings, and ambiguous cell structures are unsupported. Independent retained-sheet, row, cell, aggregate Unicode-character, traversed-part, shared-string-structure, and worksheet-structure limits produce explicit truncation flags or whole-result structured rejection as appropriate. Comments, styles, merged-cell semantics, images, charts, drawings, pivot data, macros, external links, embedded files, document properties, custom properties, relationship targets, package entry names, raw XML, and parser details are not returned. Malformed selected XML and structural or part limits reject without partial workbook metadata or cells.

DOCX inspection treats each document as a separate constrained ZIP/OPC format and uses the same focused, namespace-aware XML dependency without exposing generic archive metadata. It validates the complete central directory, content types, the root office-document relationship, and optional document relationships. It reads only `[Content_Types].xml`, root relationships, the validated main document part, optional document relationships, and optional core properties. Selected parts retain aggregate compressed and uncompressed limits, bounded deflate output, size verification, and CRC verification. Successful output contains `documentFormat: "docx"`, a deterministic allowlist of core properties, and a separately bounded body preview. The preview retains only direct body paragraphs and direct run text, tabs, and line breaks, with independent source-part, Unicode-character, paragraph, and visited-structure limits plus explicit truncation flags. It omits tables, hyperlinks, revisions, fields, text boxes, comments, headers, footers, footnotes, endnotes, images, macros, external links, embedded files, custom properties, relationship targets, package entry names, raw XML, and parser details. Malformed body XML and configured structural limits reject the whole result without partial metadata or text.

PPTX inspection treats each presentation as a separate constrained ZIP/OPC format without exposing generic archive metadata. It validates the complete central directory, content types, the root office-document relationship, the resolved presentation declaration, and presentation relationships. It reads only `[Content_Types].xml`, root relationships, `ppt/presentation.xml`, its relationships, optional core properties, and validated slide parts in presentation order. Selected parts use the same shared bounded package reader as XLSX and DOCX. Low-level OPC XML and relationship safety is also shared, while presentation schemas, allowed relationship types, metadata allowlists, declaration limits, and output construction remain isolated. Successful output contains `presentationFormat: "pptx"`, the total slide count, a deterministic allowlist of core properties, and ordered slide previews. Each preview retains only DrawingML paragraphs directly under presentation shape text bodies and direct run or field text, with independent traversed-part, retained-slide, aggregate Unicode-character, per-slide text-block, and aggregate visited-structure limits plus explicit truncation flags. Notes, comments, speaker metadata, images, videos, charts, diagrams, macros, external links, embedded files, custom properties, relationship targets, package entry names, raw XML, and parser details are not read or returned. Malformed slide XML and structural or part limits reject the whole result without partial metadata or text.

Image inspection reads a source only after checking its byte size and parses JPEG marker or PNG chunk framing directly without an image codec. Declared width and height are validated independently, and the pixel-count limit is checked by safe integer division before multiplication or pixel allocation. JPEG inspection accepts only single-scan, 8-bit baseline sequential SOF data, validates frame components, scan selectors, segment framing, and scan framing, rejects arithmetic-coded and other unsupported frame structures, and reads only allowlisted IFD0 ASCII description, author, and copyright values from EXIF APP1. PNG inspection validates the signature, IHDR, color-mode declaration, supported chunk ordering, lengths, type bits, and every CRC; IDAT bytes are never inflated. Animated PNG, unknown critical chunks, and ancillary chunks outside the deliberately narrow `tEXt` subset are rejected. Only uncompressed `tEXt` values with valid exact Title, Author, Description, or Copyright keywords are retained. Comments, GPS, thumbnails, maker notes, profiles, arbitrary EXIF, unknown text fields, pixel payloads, raw markers, and raw chunks are never returned. Successful output contains only format, dimensions, bounded allowlisted metadata, and explicit field and Unicode string truncation flags. Rejections contain no partial metadata or parser details.

All inspection still starts and ends with resolution through the same long-lived `FileRegistry`. Public results contain the opaque `fileId` and metadata, never a raw filesystem path. Inspection provides content and rule signals only; it does not classify, choose a destination, or mutate files.

Classification validation is a separate provider-independent core operation in `src/core/classification/validateSubmittedClassification.ts`. It accepts a trusted fresh `FileInspection` and one untrusted strict `{ area, documentType, rationale }` object. It validates existing taxonomy IDs and `unknown` compatibility, derives `fileId` from the inspection, copies trusted ordered rule evidence, and registers the exact result in the existing process-local WeakSet capability. Invented IDs, extra fields, overlong rationales, and partial-unknown combinations return `CLASSIFICATION_INVALID_SUBMISSION`.

Preview planning in `src/core/planning/previewOrganizationPlan.ts` accepts only that exact process-local classification object; cloned or reconstructed objects are rejected. It resolves the opaque file ID through the original `FileRegistry`, validates the current scanned identity, maps controlled taxonomy IDs through explicit fixed path segments, canonicalizes the configured organization root, rejects unsafe filenames, reserved names, symlinked destination ancestors, source/destination identity, containment failures, and excessive path bytes, and reports existing-target conflicts without mutation.

## Roadmap to a useful first organizer

Implement these milestones in order while preserving opaque file IDs, path containment, stale-file validation, bounded inspection, structured errors, and explicit mutation consent:

1. **Improve bounded document-content inspection.** DOCX direct body-paragraph, PPTX shape text-body, and XLSX scalar cell previews are available under independent limits. Bounded PDF text inspection was evaluated and blocked on the focused parser's missing content-stream, CMap, and font-decoding support; metadata-only PDF inspection remains the safe boundary. Reconsider text only through an explicit dependency and threat-model decision, never by introducing an ad hoc or unbounded parser.
2. **Add host-model classification constrained to existing taxonomy IDs.** Provider-independent validation and the narrow opaque-ID MCP submission workflow are implemented.
3. **Add preview-only organization plans.** The deterministic core operation, process-local capability boundary, explicit path mappings, conflict reporting, path omission, capability-safe combined MCP exposure, and focused safety tests are implemented.
4. **Require explicit confirmation.** Implemented as a separate strict plan-ID MCP operation that atomically consumes an expiring process-local plan, revalidates current filesystem state, and issues a separate short-lived confirmation capability without mutation.
5. **Add safe move execution.** Implemented through startup-integrated SQLite authority, coordinated recovery, a strict confirmation-ID MCP tool, pinned filesystem identities, immediate revalidation, pre-existing controlled directories, and exclusive same-filesystem hard-link/unlink moves.
6. **Add SQLite audit history and undo.** Persist the minimum data needed to explain and reverse completed operations. Validate current file identities and destination availability before undo, record undo outcomes, and fail safely on conflicts or externally changed files.
7. **Package the server for regular use.** Add a production build and executable entrypoint, MCP client configuration examples, startup diagnostics, and concise operational safeguards for real inboxes. Graceful shutdown, schema migration, retention, spawned-stdio coverage, and crash-recovery tests are implemented.

The detailed handoff below records the implemented safety increments through controlled destination-directory creation. After every increment, update this README with the complete current state, verified test count, and detailed next steps.

## Next-session handoff

Current state after the controlled destination-directory creation increment:

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
18. XLSX receives bounded read-only workbook metadata and scalar cell preview inspection through `src/core/inspector/inspectXlsx.ts` and the focused, namespace-aware `saxes` XML parser.
19. XLSX source size and package entry count are checked before workbook XML parsing with `maxXlsxSourceBytes` and `maxXlsxPackageEntries`.
20. Only content types, root relationships, the resolved workbook declaration, workbook relationships, validated worksheet parts in workbook order, and at most one validated shared-string part are decompressed; arbitrary package metadata is never read.
21. Selected metadata and preview parts are bounded by aggregate compressed and uncompressed limits, bounded deflate output, declared-size verification, and CRC verification.
22. XLSX output contains `workbookFormat: "xlsx"`, total sheet count, sheet names in workbook order, deterministic sparse sheet, row, and typed scalar cell previews, and explicit truncation flags.
23. XLSX worksheet declarations, retained names, name Unicode values, traversed worksheet parts, retained sheets, retained rows per sheet, retained cells per row, aggregate retained Unicode characters, shared-string structures, and aggregate worksheet structures are bounded independently.
24. XLSX relationship resolution normalizes internal targets, rejects absolute, external, encoded or literal traversal, URI, query, fragment, and backslash targets, and requires expected workbook, worksheet, and shared-string relationship and content types.
25. Encrypted, macro-enabled, malformed, unsupported-feature, unsafe-entry-name, unsafe-relationship, duplicate-part, and configured-limit XLSX packages return explicit structured reasons without partial metadata.
26. XLSX retains only exact source number lexemes, booleans, plain inline strings, and plain shared strings. Formula cells and cached formula values are omitted; errors, dates, rich strings, comments, styles, merged-cell semantics, images, charts, drawings, pivot data, macros, external links, embedded files, document properties, and custom properties are not interpreted or returned.
27. DOCX receives bounded read-only core-property inspection through `src/core/inspector/inspectDocx.ts` and the focused, namespace-aware `saxes` XML parser.
28. DOCX source size and package entry count are checked before metadata XML parsing with `maxDocxSourceBytes` and `maxDocxPackageEntries`.
29. Only content types, root relationships, the validated main document part, optional document relationships, and optional core properties are decompressed; arbitrary package metadata is never read.
30. Required DOCX metadata parts are bounded by aggregate compressed and uncompressed limits, bounded deflate output, declared-size verification, and CRC verification.
31. DOCX output contains `documentFormat: "docx"`, allowlisted core properties, and bounded direct body-paragraph text with explicit paragraph and character truncation flags.
32. DOCX metadata fields and Unicode values are bounded independently with `maxDocxMetadataFields` and `maxDocxMetadataStringLength`, with explicit field and string truncation flags.
33. DOCX relationship resolution rejects absolute, external, encoded or literal traversal, URI, query, fragment, and backslash targets, and validates supported relationship types without exposing targets.
34. Encrypted, macro-enabled, malformed, unsupported-feature, unsafe-entry-name, unsafe-relationship, duplicate-part, and configured-limit DOCX packages return explicit structured reasons without partial metadata.
35. DOCX body extraction retains only direct body paragraphs and direct run text, tabs, and line breaks; it omits tables, hyperlinks, revisions, fields, text boxes, comments, headers, footers, notes, images, macros, external links, embedded files, custom properties, and arbitrary package metadata.
36. PPTX receives bounded read-only presentation metadata inspection through `src/core/inspector/inspectPptx.ts` and the focused, namespace-aware `saxes` XML parser.
37. PPTX source size and package entry count are checked before presentation XML parsing with `maxPptxSourceBytes` and `maxPptxPackageEntries`.
38. Only content types, root relationships, the resolved presentation declaration, presentation relationships, optional core properties, and validated slide parts in presentation order are decompressed; arbitrary package metadata is never read.
39. Required PPTX metadata parts are bounded by aggregate compressed and uncompressed limits, bounded deflate output, declared-size verification, and CRC verification.
40. PPTX output contains `presentationFormat: "pptx"`, total slide count, allowlisted title, subject, creator, keywords, description, and last-modified-by fields, and deterministic ordered slide previews.
41. PPTX slide declarations, metadata fields, metadata Unicode values, traversed slide parts, retained slides, retained slide Unicode characters, text blocks retained per slide, and aggregate visited slide XML structures are bounded independently.
42. PPTX relationship resolution rejects absolute, external, encoded or literal traversal, URI, query, fragment, and backslash targets, and validates supported relationship types without exposing targets.
43. Encrypted, macro-enabled, malformed, unsupported-feature, unsafe-entry-name, unsafe-relationship, duplicate-part, and configured-limit PPTX packages return explicit structured reasons without partial metadata.
44. PPTX slide extraction retains only direct `p:sp/p:txBody/a:p/(a:r|a:fld)/a:t` text; it omits unsupported ancestry, notes, comments, speaker metadata, images, videos, charts, diagrams, macros, external links, embedded files, custom properties, and arbitrary package metadata.
45. Other formats return metadata and rule evidence with `UNSUPPORTED_FORMAT`.
46. Inspection output never exposes raw filesystem paths.
47. Temporary-directory PPTX tests use compact generated fixtures and cover empty and multiple-slide presentations; ordered direct runs and fields; multi-run concatenation; allowlisted metadata; all twelve configured limits; non-ASCII truncation; malformed ZIP, presentation XML, metadata XML, and slide XML, including unretained slides; encrypted, macro-enabled, and unsupported packages; unsafe entries and relationships; duplicate and missing parts; excluded ancestry and custom-property content; path omission; rule evidence; and files changed after scanning.
48. `.env.example` documents CSV, JSON, ZIP, PDF, XLSX, DOCX, PPTX, JPEG, and PNG inspection limits.
49. JPEG and PNG receive dependency-free bounded metadata inspection through `src/core/inspector/inspectImage.ts` without decoding or allocating pixels.
50. Image source bytes, dimensions, declared pixel counts, traversed markers or chunks, retained metadata fields, and metadata Unicode strings are bounded independently.
51. JPEG inspection validates marker, segment, frame-component, and scan-selector framing, accepts only single-scan baseline sequential 8-bit SOF data, rejects arithmetic coding and unsupported frame structures, and retains only allowlisted IFD0 description, author, and copyright fields from EXIF APP1.
52. PNG inspection validates the signature, IHDR declaration, supported chunk framing, ordering, type bits, lengths, and CRCs without inflating IDAT; it rejects unvalidated ancillary structures and retains only exact allowlisted uncompressed textual fields.
53. Image output contains only format, dimensions, allowlisted metadata, and explicit metadata truncation flags; it omits GPS, thumbnails, maker notes, profiles, comments, private metadata, raw structures, and pixel payloads.
54. Malformed, unsupported-feature, invalid-dimension, oversized-source, excessive-pixel, and excessive-structure image results use explicit structured reasons without partial metadata.
55. Compact generated temporary-directory image fixtures cover both formats, allowlisting, Unicode truncation, all configured limits, malformed framing and CRCs, unsupported features, omitted private and pixel content, path omission, rule evidence, and stale files.
56. XLSX, DOCX, and PPTX now share `src/core/inspector/ooxmlPackage.ts` for bounded source reads, central-directory parsing, safe part-name normalization, selected-member decompression, and package-level rejection categories.
57. The shared reader preserves each inspector's existing public result and maps generic package failures back to the exact format-specific structured reason.
58. Selected OOXML metadata members must end before the central directory; local flags, compression method, filename, CRC, compressed size, and uncompressed size are checked against central declarations when no data descriptor is used.
59. Deflate output is bounded by both the configured metadata limit and the member's declared uncompressed size; duplicate requested parts are decompressed only once; declared sizes and CRCs remain mandatory.
60. Focused shared-reader tests cover valid bounded reads, contradictory local declarations, member overlap with the central directory, and declared-size inflation bounds.
61. XLSX, DOCX, and PPTX now share `src/core/inspector/opcXml.ts` for strict UTF-8 XML decoding, XML declaration and doctype policy, namespace-aware attribute access, content-type override parsing, relationship envelope parsing, relationship-part naming, and internal target normalization.
62. Generic OPC XML failures map back to each format's existing `MALFORMED_*`, `UNSUPPORTED_*_FEATURE`, `UNSAFE_*_RELATIONSHIP`, and `DUPLICATE_*_PART` reasons without exposing generic failures publicly.
63. Workbook, document, and presentation schemas, allowed relationship types, macro policies, metadata allowlists, declaration limits, and output construction remain format-specific.
64. Focused OPC primitive tests cover UTF-8 and XML policy, namespace-aware attributes, content-type overrides, duplicate declarations, relationship envelopes, relationship-part names, and safe and unsafe target normalization.
65. The stdio MCP server exposes strict scan, inspection, host-submitted preview, directory, confirmation, and execution tools. All are closed-world; preview is non-idempotent because it issues a fresh process-local plan capability.
66. Each MCP server instance creates one long-lived `FileRegistry`; every inspection resolves only an opaque ID issued by that instance, and raw paths are absent from the inspection contract.
67. MCP inputs and outputs are schema-validated. Structured failures preserve stable `OrganizerError` codes and safe messages without stack traces, parser details, causes, or filesystem paths.
68. MCP transport tests cover tool discovery, successful scan and inspection calls, same-instance ID continuity, cross-instance and fabricated IDs, stale files, invalid and raw-path inputs, unsupported formats, rule evidence, and path omission.
69. Verification is recorded after each completed safety increment.
70. No OCR, pixel decoding, image mutation, full spreadsheet data extraction, archive extraction to disk, PDF content extraction, broad user-facing audit history, or undo exists. Filesystem mutation is limited to separately confirmed controlled-directory creation and exclusive same-filesystem regular-file moves.
71. DOCX body previews traverse only one validated main document source part and independently bound retained Unicode characters, retained paragraphs, and visited XML structures.
72. `DOCX_BODY_PART_LIMIT_EXCEEDED` and `DOCX_BODY_STRUCTURE_LIMIT_EXCEEDED` reject without partial output; character and paragraph retention limits truncate successfully with separate flags.
73. Compact generated fixtures cover empty and multiple paragraphs, tabs and line breaks, Unicode truncation, every new body limit, malformed body XML, excluded containers and parts, stale files, and path omission.
74. PPTX slide previews traverse every validated slide part in presentation order, validate declared slide content types, and retain only deliberately supported DrawingML shape text-body paragraphs.
75. `PPTX_SLIDE_PART_LIMIT_EXCEEDED` and `PPTX_SLIDE_STRUCTURE_LIMIT_EXCEEDED` reject without partial output; retained-slide, aggregate-character, and per-slide text-block limits truncate successfully with explicit flags.
76. Compact generated PPTX fixtures cover ordered direct run and field text, multi-run blocks, Unicode truncation, every slide-preview limit, malformed retained and unretained slide XML, excluded XML ancestry and package parts, stale files, rule evidence, and path omission.
77. XLSX worksheet previews traverse every validated worksheet part in workbook order and validate each worksheet root, sparse row coordinate, sparse cell coordinate, supported scalar structure, and referenced shared-string index without allocating rectangular cell grids.
78. `XLSX_WORKSHEET_PART_LIMIT_EXCEEDED`, `XLSX_WORKSHEET_STRUCTURE_LIMIT_EXCEEDED`, and `XLSX_SHARED_STRING_STRUCTURE_LIMIT_EXCEEDED` reject without partial output; retained-sheet, row, cell, and character limits truncate successfully with explicit flags while all selected XML remains completely validated.
79. Compact generated XLSX fixtures cover empty and multiple sheets, workbook-order relationship resolution, sparse rows and cells, supported scalar types, shared strings, exact number lexemes, formula-cache omission, Unicode truncation, every new configured limit, malformed retained and unretained worksheet XML, malformed and rich shared strings, invalid indexes, excluded package parts, stale files, deterministic rule evidence, and path omission.
80. Bounded PDF text inspection was evaluated against `pdf-lib` 1.17.1 and intentionally not implemented because the dependency has no content-stream parser, text extraction API, `ToUnicode`/CMap reader, or font-to-Unicode decoding path.
81. `pdf-lib` can decode supported raw-stream filters, but that API exposes decoded bytes without a caller-supplied output bound and does not validate PDF text operators or mappings; using it directly would not satisfy complete validation, malformed unretained-content rejection, unsupported-font rejection, or bounded parser-work requirements.
82. The existing PDF metadata behavior, public extraction type, structured reasons, limits, MCP surface, dependencies, and tests remain unchanged; no broad PDF parser, ad hoc operator parser, OCR, rendering, or partial text extraction was added.
83. `src/core/classification/validateSubmittedClassification.ts` validates untrusted host output independently of any provider, derives the opaque file ID from a trusted fresh inspection, copies trusted ordered evidence, and registers the exact result as a process-local capability.
84. The accepted submission is exactly `{ area, documentType, rationale }`; controlled IDs, all-or-nothing `unknown` compatibility, strict fields, and a 1000-character rationale bound are enforced.
85. `submit_classification_and_preview_file` accepts only the opaque file ID and nested classification. It freshly calls `inspectFile`, validates and registers the submission, and passes that exact object to `OrganizationPlanRegistry.preview`.
86. The MCP server has no classification provider, model configuration, credential input, OpenAI dependency, or classification network path. A spawned stdio regression test installs outbound request tripwires and succeeds without `OPENAI_API_KEY`.
87. The classification result retains its compile-time brand and process-local WeakSet capability; cloned, serialized, reconstructed, or fabricated objects remain invalid for planning.
119. `src/core/planning/previewOrganizationPlan.ts` adds a separate deterministic preview-only operation that accepts the exact validated classification capability, a supplied long-lived `FileRegistry`, and bounded planning configuration.
120. Cloned, serialized, reconstructed, or otherwise fabricated classification objects return `PLAN_INVALID_CLASSIFICATION`; planning does not accept raw paths, inspection payloads, evidence payloads, taxonomy fields, rationales, destinations, prompts, or credentials as independent caller input.
121. Planning immediately re-resolves the proposal's opaque file ID through the supplied registry, preserving fabricated-ID, cross-instance-ID, missing-file, and stale-file rejection before creating a plan record.
122. `src/core/planning/destinationMappings.ts` defines complete explicit mappings for every controlled area and document-type ID. Model rationale and filename-derived content are never interpolated into directory names.
123. Unknown classifications map only to the controlled `_Review/_Review` destination segments; incompatible partial-unknown proposals remain invalid.
124. Planning canonicalizes and validates the configured organization root, requires it to exist as a directory, checks destination containment and source/destination pathname and filesystem identity, and rejects existing symlinked or non-directory destination ancestors.
125. Source filenames reject empty, dot, traversal-separator, control-character, trailing-dot, trailing-space, and Windows reserved-name forms before destination construction.
126. Proposed destination UTF-8 bytes are independently bounded by `maxPlanPathBytes`, configured through `ORGANIZER_MAX_PLAN_PATH_BYTES`; excessive destinations return `PLAN_DESTINATION_TOO_LONG`.
127. Existing targets are inspected without mutation and reported as `none`, `existing-file`, `existing-directory`, or `existing-other` conflicts.
128. Each successful preview returns a fresh opaque `planId`, the opaque source `fileId`, controlled taxonomy IDs, fixed safe display segments, the source filename, and conflict state. It never returns the organization root, source path, destination path, or internal identity record.
129. The process-local plan registry retains an internal copy of the exact resolved source identity and validated destination path so a future execution increment can revalidate fabricated, stale, changed, expired, or already-used plans without trusting display output.
130. Repeated previews are deterministic apart from fresh opaque plan capabilities and current conflict state; they create no directories, files, database records, or filesystem mutations.
131. Preview planning does not accept serialized classification results; MCP exposure validates and registers host output inside one server-owned flow and never exposes replayable classification authority.
132. Focused temporary-directory tests cover every taxonomy mapping, unknown classification, runtime capability replay rejection, stale files, invalid taxonomy values, all conflict kinds, hard-linked source/destination identity, reserved and unsafe filenames, path-byte limits, missing roots, symlinked ancestors, deterministic repeated previews, path omission, and absence of mutation.
133. PDF remains metadata-only; no PDF content extraction, broad parser, ad hoc operator parser, OCR, or rendering was added.
134. No execution, confirmation, audit history, undo, SQLite, or mutation tool was added in the preview-planning increment.
135. `npm test` passes 163 tests, `npm run typecheck` passes, and `git diff --check` passes as of the core-only preview-planning increment.
136. The MCP server exposes `submit_classification_and_preview_file` with strict `{ fileId, classification: { area, documentType, rationale } }` input; it performs registry-backed inspection, local validation, and deterministic preview planning inside one server-owned call.
137. The handler passes the exact registered object directly to planning. It does not accept serialized inspections, evidence, destinations, prompts, provider settings, credentials, or raw paths.
138. Each MCP server instance creates one long-lived `OrganizationPlanRegistry` alongside its long-lived `FileRegistry`; plan capabilities and retained source and destination identities are process-local and cannot cross server instances.
139. Combined preview output contains only `planId`, `fileId`, controlled area and document-type IDs, fixed safe relative display segments, the source filename, and the closed conflict enum. It omits rationale, rule evidence, organization root, source path, destination path, and internal identity records.
140. `submit_classification_and_preview_file` is read-only, non-destructive, closed-world, and non-idempotent because each call issues a fresh plan ID.
141. Combined preview preserves fabricated-ID, cross-instance-ID, stale-file, changed-during-inspection, and changed-during-planning-revalidation failures before retaining a plan.
142. In-memory MCP tests cover discovery, closed-world annotations, successful submission, safe output, taxonomy validation, same-instance continuity, cross-instance and fabricated IDs, stale files, planning revalidation, conflicts, strict input rejection, path and secret omission, and absence of mutation.
143. The spawned-stdio test proves the submission workflow works without `OPENAI_API_KEY` and fails on any attempted outbound request.
144. No proposal-only classification tool or replayable classification-capability tool is exposed.
146. PDF remains metadata-only; no PDF content extraction, broad parser, ad hoc operator parser, OCR, or rendering was added.
147. No execution, confirmation, audit history, undo, SQLite, directory creation, file move, or other mutation tool was added while exposing preview plans.
148. `npm test` passes 169 tests, `npm run typecheck` passes, and `git diff --check` passes as of the capability-safe MCP preview-plan increment.
149. Plan previews now expire after the independently bounded `ORGANIZER_PLAN_EXPIRY_MS`; public previews include only the safe RFC 3339 expiry in addition to their existing fields.
150. `ORGANIZER_CONFIRMATION_EXPIRY_MS` independently bounds the lifetime of a separate process-local confirmation capability. Both lifetime settings require positive integers and have fixed maximums.
151. `OrganizationPlanRegistry` now owns atomic plan lifecycle states. Confirmation changes `pending` to `confirming` synchronously before any await, so concurrent attempts cannot both succeed.
152. Expired, consumed, invalidated, and currently confirming plans never return to pending. Failed revalidation consumes the attempted plan rather than allowing a raced retry.
153. Confirmation accepts only an exact opaque `planId` retained by the same registry. Fabricated and cross-instance IDs return `INVALID_PLAN_ID`; expired, repeated, changed, and conflicting plans use dedicated sanitized errors.
154. Confirmation revalidates the retained organization root, source registry identity, destination containment, destination ancestors, source/destination identity, and current destination conflict without trusting caller-supplied preview fields.
155. Only plans whose preview and current conflict are both `none` can produce confirmation authority. Collision resolution, overwrite, merging, and automatic renaming remain unsupported.
156. A successful confirmation atomically consumes the plan and issues a fresh opaque `confirm_*` capability bound internally to the exact plan, source identity, destination, and independent expiry.
157. Confirmation output contains only `confirmationId`, `planId`, `fileId`, and `expiresAt`; it omits source and destination paths, taxonomy values, internal identities, configuration, and filesystem diagnostics.
158. The MCP server exposes strict `confirm_organization_plan` input containing only `{ planId }`. It is local, non-destructive, non-idempotent, and marked non-read-only because it mutates process-local capability state, but it does not mutate the filesystem or make network requests.
159. Focused core tests cover deterministic lifetime boundaries, exact-deadline expiry, fabricated and cross-registry plans, one-time and concurrent confirmation, changed source and destination state, pre-existing conflicts, terminal failed attempts, safe output, and absence of mutation.
160. In-memory MCP tests cover discovery and annotations, same-instance confirmation, safe output shape, repeated, fabricated, cross-instance, expired, and changed plans, strict input rejection, path omission, and filesystem non-mutation.
161. Confirmation capabilities are retained for the core-only execution operation described in items 164-177. No MCP operation consumes them, and no directory creation, audit history, undo, or SQLite behavior was added.
162. PDF remains metadata-only; no PDF content extraction, broad parser, ad hoc operator parser, OCR, or rendering was added.
163. `npm test` passes 177 tests, `npm run typecheck` passes, and `git diff --check` passes as of the confirmation-capability increment.
164. `FileRegistry` now pins the canonical inbox root and retains scan-time device and inode values internally. Resolution requires the same canonical root and validates device and inode together with regular-file status, size, and modification time; same-size replacements with preserved timestamps and inbox-root symlink swaps are rejected without exposing filesystem identity publicly.
165. `OrganizationPlanRegistry.execute` is a core-only consumer for the exact process-local `confirmationId`; no caller supplies a path, destination, plan fields, file identity, taxonomy value, or mutation setting.
166. Confirmation lifecycle is atomic and terminal: `ready` changes synchronously to `executing` before any await, then to `consumed`, `invalidated`, or `expired`. Concurrent, repeated, expired, fabricated, cross-registry, and failed attempts cannot become implicitly retryable.
167. Execution immediately revalidates the canonical organization root, retained source registry identity, source regular-file status and device/inode, destination containment, every existing destination ancestor, destination-directory status, destination absence, and same-filesystem identity.
168. The first execution increment requires the complete controlled destination directory to pre-exist. It creates no directory and reports `EXECUTION_DESTINATION_UNAVAILABLE` when the directory is absent or unsuitable.
169. Portable Node `rename()` was not used because it can overwrite a destination created after validation. The implementation instead uses same-filesystem hard-link creation, whose destination creation is exclusive, followed by source unlink.
170. Exclusive-link `EEXIST` races return `EXECUTION_CONFLICT`; `EXDEV` and preflight device mismatches return `EXECUTION_CROSS_FILESYSTEM`. Overwrite, merge, automatic rename, copy-and-delete, and cross-filesystem fallback remain unsupported.
171. After exclusive destination creation, both source and destination entries are rechecked as regular files referencing the retained scanned device and inode before source removal.
172. Failure after destination creation returns terminal `EXECUTION_PARTIAL`, preserving both entries whenever the source entry still exists. The core does not claim crash-atomic rename semantics or perform unsafe automatic cleanup.
173. Successful execution returns only `confirmationId`, `planId`, `fileId`, and `status: "completed"`. It returns no source path, destination path, root, taxonomy data, filesystem identity, or diagnostics.
174. Completed confirmations remain consumed, so a retry after a lost successful response cannot duplicate the move. Without durable state, process crashes still prevent authoritative replay or recovery and therefore block MCP mutation exposure.
175. Focused temporary-directory tests cover exact confirmation expiry, fabricated and cross-registry IDs, concurrent execution, completed-response retry, source replacement, inbox-root and destination-ancestor symlink swaps, absent destination directories without partial creation, destination races, cross-filesystem error mapping, post-link source swaps, partial unlink failure, safe output, path omission, and exact filesystem outcomes.
176. PDF remains metadata-only; no PDF content extraction, broad parser, ad hoc operator parser, OCR, or rendering was added.
177. No MCP mutation tool, directory creation, audit history, undo, SQLite, overwrite, merge, automatic rename, copy-and-delete, or cross-filesystem move was added.
178. `npm test` passes 185 tests, `npm run typecheck` passes, and `git diff --check` passes as of the core-only execution increment.
179. Exclusive same-filesystem hard-link creation followed by source unlink is now the explicit portable product boundary; no native addon, overwrite-capable rename, cross-filesystem fallback, or directory creation was added.
180. `src/core/planning/executionStore.ts` defines the minimum durable execution record and both in-memory and SQLite implementations. The record retains confirmation and plan authority, safe-result IDs, exact source and root identities, intended destination, expiry, lifecycle phase, and recovery outcome internally.
181. SQLite transitions use strict schema constraints, full synchronous durability, WAL journaling, bounded busy waits, and transactional compare-and-set claiming so only one process can change a ready confirmation to executing.
182. Confirmation authority is persisted before it is returned. Execution can therefore revalidate and consume a confirmation after a process restart without reconstructing authority from caller-supplied paths, identities, taxonomy values, or destination fields.
183. Durable execution phases are `prepared`, `destination-created`, and `source-removed`; lifecycle states are `ready`, `executing`, `completed`, `invalidated`, and `expired`.
184. Recovery validates canonical inbox and organization root device/inode identities, containment, destination ancestors, and retained file device/inode identity before acting. It never overwrites or removes unrelated entries.
185. Recovery before destination creation invalidates the interrupted operation without mutation. Recovery with both retained hard links removes only the verified source entry. Recovery with only the verified destination marks completion. Any other state is invalidated safely.
186. Completed durable operations return the prior path-free success envelope after restart without repeating filesystem mutation, providing defined lost-response behavior.
187. `FileRegistry` now pins inbox-root device and inode as well as its canonical path and retains exact scan-time modification precision internally; these additional identities remain absent from public scan, inspection, planning, confirmation, execution, and MCP output.
188. Post-destination failures remain recoverable durable operations rather than being made implicitly retryable. Calls before recovery report that execution is already in progress; startup recovery resolves the operation terminally.
189. Fault-injection tests cover crashes before destination creation, after destination creation, and after source removal; safe unrelated-entry handling; durable result replay; and fresh-process post-link recovery with path-free stdout and stderr.
190. No MCP execution tool, automatic startup wiring, controlled directory creation, broad audit history, undo, overwrite, merge, automatic rename, copy-and-delete, or cross-filesystem move was added. The durable store and recovery coordinator remain core-only.
191. PDF remains metadata-only; no PDF content extraction, broad parser, ad hoc operator parser, OCR, or rendering was added.
192. `npm test` passes 190 tests, `npm run typecheck` passes, and `git diff --check` passes as of the durable execution and recovery increment.

193. MCP startup constructs one `SqliteExecutionStore` from `ORGANIZER_DATABASE_PATH`, gives it to the long-lived `OrganizationPlanRegistry`, and completes recovery before connecting the stdio transport.
194. SQLite recovery claims use owner-scoped leases and atomic writes. Concurrent startup processes cannot recover one executing record simultaneously; non-owners wait until the record is terminal or its bounded lease can be reclaimed.
195. Database initialization, lock, schema, corruption, or recovery failures are sanitized to `EXECUTION_STORAGE_FAILED`. Scan, inspection, submitted-classification preview, and directory preview remain available; confirmation and execution are disabled for that process.
196. The MCP server exposes strict `execute_organization_plan` input containing only `{ confirmationId }`. It is annotated destructive, non-read-only, non-idempotent, and closed-world, and its description requires explicit prior user approval through preview and confirmation.
197. Execution accepts no paths, destination fields, plan fields, taxonomy values, overwrite flags, rename settings, or other mutation options.
198. Successful MCP execution returns only `confirmationId`, `planId`, `fileId`, and `status: "completed"`. Durable completed results replay after restart without repeating mutation.
199. Startup recovery covers `prepared`, `destination-created`, and `source-removed` records before requests are accepted. It preserves the existing root, ancestor, source, destination, containment, device, inode, and unrelated-entry checks.
200. The destination directory must already exist. Collision, overwrite, merge, automatic rename, directory creation, cross-filesystem copy-and-delete, and other fallback policies remain closed.
201. Durable execution records currently have no automatic cleanup: ready and executing records are retained for authority and recovery, and completed records are retained indefinitely for authoritative lost-response replay. A bounded administrative retention design is required before cleanup can be added.
202. Spawned-stdio tests cover startup recovery for every persisted phase, completed-result replay, corrupt-database partial availability, and path-free stderr. Core and MCP tests cover recovery claims, strict execution inputs, annotations, unavailable destinations, safe result shape, replay, and exact filesystem outcomes.
203. PDF remains metadata-only; no PDF content extraction, broad parser, ad hoc operator parser, OCR, or rendering was added.
204. No controlled directory creation, broad audit history, cleanup, undo, overwrite, merge, automatic rename, copy-and-delete, or cross-filesystem move was added.
205. `npm test` passes 196 tests, `npm run typecheck` passes, and `git diff --check` passes as of the startup integration and MCP execution exposure increment.

206. SQLite durable state now uses explicit `PRAGMA user_version = 1` schema versioning. Startup validates the complete known schema, migrates the prior unversioned execution schema transactionally, and rejects unknown future or malformed schemas as sanitized `EXECUTION_STORAGE_FAILED` while preserving read-only MCP availability.
207. Schema version 1 adds an internal nullable `terminal_at` timestamp. Existing terminal records receive the migration time as a conservative retention origin; ready and executing authority remains untimed and is never removed by retention cleanup.
208. Terminal retention is independently configured by `ORGANIZER_INVALIDATED_EXECUTION_RETENTION_MS`, `ORGANIZER_EXPIRED_EXECUTION_RETENTION_MS`, and `ORGANIZER_COMPLETED_EXECUTION_REPLAY_RETENTION_MS`. Defaults retain invalidated and expired records for 30 days and completed replay authority for 365 days.
209. Startup performs bounded-state administrative cleanup only after recovery completes. Cleanup deletes only terminal records whose exact state-specific horizon has elapsed; SQLite foreign-key cascades remove associated recovery claims. Ready and executing records are retained without exception.
210. After a completed replay record's explicit authority horizon elapses, its confirmation ID is no longer authoritative and returns `INVALID_CONFIRMATION_ID`; filesystem mutation is not retried or reconstructed from caller input.
211. Recovery lease duration is independently configured by `ORGANIZER_EXECUTION_RECOVERY_LEASE_MS`, bounded to 60 seconds, and passed to every startup-owned SQLite store. A killed owner cannot release its lease early, but another process reclaims it at the bounded deadline.
212. Spawned-process tests hold a real SQLite write lock and verify startup waits for bounded lock release before accepting requests. Separate process-level tests kill a recovery lease owner, verify takeover after lease expiry, and prove the MCP transport does not accept a request while the durable executing record remains unresolved.
213. `OrganizationPlanRegistry` tracks active execution promises. The startup-owned MCP lifecycle exposes idempotent graceful shutdown that waits for active execution to become terminal before closing SQLite.
214. The stdio entrypoint waits for MCP transport closure and then invokes graceful durable shutdown. In-memory and partial-availability servers retain no-op shutdown behavior when they do not own SQLite.
215. Focused tests cover fresh schema versioning, legacy migration, future-schema rejection, schema validation, exact independent retention boundaries in memory and SQLite, active-authority preservation, active-execution shutdown waiting, idempotent storage closure, spawned database locks, killed lease owners, bounded takeover, request gating, and path-free diagnostics.
216. The exclusive same-filesystem hard-link creation followed by source unlink boundary remains unchanged. No overwrite, merge, automatic rename, directory creation, copy-and-delete, cross-filesystem fallback, broad audit history, or undo behavior was added.
217. PDF remains metadata-only; no PDF content extraction, broad parser, ad hoc operator parser, OCR, or rendering was added.
218. `npm test` passes 203 tests, `npm run typecheck` passes, and `git diff --check` passes as of the operational hardening and retention increment.

219. Controlled destination-directory creation is a separate preview, confirmation, durable execution, recovery, and replay authority. It is never an implicit side effect of file movement.
220. `preview_organization_directories` accepts only a same-process `planId`, consumes that move plan, and returns only controlled segment names and `existing` or `missing` statuses. A fresh move preview is required after creation.
221. `confirm_organization_directories` accepts only a process-local `directoryPlanId`, revalidates exact root and ancestor state, persists separate authority, and performs no filesystem mutation.
222. `execute_organization_directories` accepts only the durable `directoryConfirmationId` and creates missing controlled segments exclusively, non-recursively, and one level at a time. It never moves a file.
223. SQLite schema version 2 adds separate directory-operation, ordered segment-evidence, and recovery-claim tables while preserving existing move records and version-1 migration behavior.
224. Durable directory evidence retains exact root identity and ownership, each controlled path, parent evidence, created directory identity and ownership, lifecycle phase, terminal timestamp, and recovery outcome internally.
225. Existing controlled ancestors are pinned at confirmation by device, inode, owner, and group. Execution revalidates the canonical root and each immediate parent before every exclusive creation.
226. Creation races, symlinks, non-directories, ownership changes, containment changes, and existing-segment identity changes are rejected with sanitized directory-specific errors.
227. Recovery completes an interrupted operation only when every controlled segment is present and every operation-owned segment matches retained identity. Otherwise it rolls back only proven-created, identity-matching empty directories from leaf to root.
228. Uncertain, replaced, non-empty, symlinked, or unrelated entries are never removed. Blocked rollback is retained as terminal `rollback-incomplete` evidence under the invalidated retention horizon.
229. Completed directory results replay without repeating mutation. Ready and executing directory authority is excluded from cleanup; terminal directory records use the existing independent invalidated, expired, and completed replay horizons.
230. Startup completes directory recovery before move recovery and before connecting stdio. Graceful shutdown waits for both active directory and move executions before closing SQLite.
231. The file-move exclusive hard-link/unlink boundary is unchanged. Directory creation adds no overwrite, merge, automatic rename, copy-and-delete, cross-filesystem fallback, broad audit history, or undo behavior.
232. PDF inspection remains metadata-only; no PDF content extraction, broad parser, ad hoc operator parser, OCR, or rendering was added.
233. `npm test` passes 189 tests, `npm run typecheck` passes, and `git diff --check` passes as of the controlled destination-directory creation increment.
