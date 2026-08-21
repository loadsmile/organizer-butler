# Organizer Butler

Organizer Butler is a local-first desktop file organizer that inspects and categorizes files without giving an AI model direct filesystem control. It combines a TypeScript safety core with an Electron interface, a Model Context Protocol (MCP) server, and a scan-only CLI.

> **Project status:** early-stage macOS arm64 prototype. Use synthetic folders while evaluating it. Organizer Butler does not overwrite files, recurse into folders, or move data across filesystems.

[Quick start](#quick-start) | [Desktop guide](#desktop-guide) | [MCP tutorial](#mcp-tutorial) | [Tool reference](#tool-reference) | [Security](#security-and-privacy) | [Roadmap](ROADMAP.md)

## Why Organizer Butler?

File organization tools usually require one of two uncomfortable trade-offs: broad filesystem permissions for an opaque automation, or repetitive manual sorting. Organizer Butler separates reasoning from authority.

- An AI can suggest a controlled category, but it cannot choose a path or move a file.
- Every destination is derived locally from a fixed taxonomy.
- Directory creation and file movement require separate previews and explicit confirmations.
- Inspection is bounded by format-specific limits and returns structured data rather than unrestricted file contents.
- Existing targets, stale files, symlinks, and cross-filesystem moves fail closed.

The result is an organizer that remains useful without AI and treats model output as untrusted input when AI is enabled.

## Interfaces

| Interface | Best for | Current capability |
| --- | --- | --- |
| Electron desktop app | Interactive, one-file-at-a-time organization | Scan, inspect, manually categorize, optionally request Codex suggestions, preview destinations, create controlled directories, and move files |
| MCP stdio server | Agent and host integrations | Complete scan-to-move workflow through eight narrow tools with strict inputs and documented outputs |
| CLI | Scripts and diagnostics | Non-recursive scan with JSON output; it does not inspect or mutate files |

All three interfaces use the same scanner and domain types. The desktop app and MCP server share `OrganizerApplication`, which owns inspection, validation, planning, durable execution, recovery, and shutdown.

## Safety model

Organizer Butler organizes one regular file at a time into this controlled shape:

```text
<organization root>/<area>/<document type>/<original filename>
```

For example, a validated `finance` and `invoice` classification becomes:

```text
Organization/Finance/Invoices/acme-2026-08.pdf
```

The workflow is deliberately split into capabilities:

1. **Scan:** discover top-level regular files and issue opaque, process-local IDs.
2. **Inspect:** extract a bounded, format-specific preview and deterministic rule evidence.
3. **Classify:** validate an untrusted area, document type, and rationale against the controlled taxonomy.
4. **Preview:** derive and revalidate the exact destination without changing the filesystem.
5. **Prepare directories:** preview, confirm, and create only missing controlled directory levels.
6. **Move:** confirm one fresh move plan, then create the destination link exclusively before unlinking the source.

Plans are short-lived and single-use. Confirmations authorize at most one mutation. Confirmed operations are recorded in SQLite before execution so interrupted work can be recovered conservatively after restart; retrying a completed confirmation replays its prior path-free result without repeating the mutation.

## Quick start

### Prerequisites

- Node.js 22.12.0 or newer (`node:sqlite` and the locked Vite toolchain are required)
- npm
- macOS for the currently exercised desktop package
- A compatible ChatGPT plan only if you want optional Codex classification

### Install

```sh
git clone git@github.com:loadsmile/organizer-butler.git
cd organizer-butler
npm ci
```

Verify the development environment:

```sh
npm run typecheck
npm test
```

### Start the desktop app

```sh
npm run dev
```

Choose a synthetic inbox and destination on the same filesystem. The app never treats folder selection as consent to mutate files; destination review and the named confirmation actions remain separate.

### Scan from the CLI

```sh
ORGANIZER_DOWNLOADS_DIRECTORY=/path/to/synthetic-inbox npm run organize
```

The CLI prints `{ "files": [...] }` as JSON. It scans only and does not initialize the execution database or expose move commands.

### Start the MCP server

```sh
ORGANIZER_DOWNLOADS_DIRECTORY=/path/to/synthetic-inbox \
ORGANIZER_ROOT=/path/to/synthetic-destination \
npm run mcp
```

Environment variables must be exported by the shell or supplied by the process launcher. The project does not load `.env` files automatically.

## Desktop guide

### 1. Choose folders

Use the native folder controls to select an inbox and destination. Both folders must already exist, be readable and writable, and be on the same filesystem. Folder selections last for the current desktop session only.

### 2. Choose manual or AI-assisted categorization

Manual categorization is always available. To request suggestions, enable **Classify automatically after scans** and sign in through the official ChatGPT browser flow.

Organizer Butler does not require an OpenAI API key. Authentication is managed by the bundled Codex runtime in an app-specific `CODEX_HOME`, with credential storage delegated to the operating-system keyring setting.

### 3. Scan and inspect

Select **Scan & classify**. The scanner reads only the inbox's top level and reports how many entries it accepted and skipped. Select a file to view its bounded extraction, rule evidence, category, confidence, and rationale.

### 4. Review the classification

Choose one area and one compatible document type, then edit the rationale if needed. Low-confidence AI suggestions are routed to `_Review/_Review`; a suggestion never creates mutation authority.

### 5. Review and execute

Select **Review destination** to see the exact relative destination and conflict state. Missing controlled directories require their own named creation action. File movement is a separate action and never overwrites or automatically renames an existing target.

> **Prototype limitation:** the current desktop direct-move path consumes its move plan while checking directories. When both controlled directories already exist, move execution fails; the equivalent MCP error is `PLAN_ALREADY_USED`, although the desktop shows only a sanitized message. The MCP workflow below is the reliable integration path until the desktop flow is corrected.

## AI classification

AI classification is optional, explicit, and constrained. After consent, the desktop app submits one file at a time to Codex using a strict schema.

| May be sent | Never sent to Codex |
| --- | --- |
| Filename and extension | Raw or canonical filesystem paths |
| MIME type, size, and modification time | Opaque file, plan, or confirmation IDs |
| Deterministic filename and extension evidence | SQLite records or filesystem identities |
| Bounded normalized inspection data | Destination authority or filesystem tools |
| Controlled area and document-type choices | Shell, web, apps, plugins, MCP, hooks, or memory access |

Codex must return one controlled area, one compatible document type, finite confidence from `0` to `1`, and a rationale of at most 1,000 characters. Results below the `0.75` acceptance threshold are routed to manual review. Organizer Butler validates every result again before planning.

The MCP server never invokes Codex and makes no classification network request. Its host is responsible for reasoning over the bounded inspection and submitting a controlled classification.

## MCP tutorial

This tutorial connects Organizer Butler to an MCP host and moves one synthetic file. Tool calls below show the input object, not a host-specific JSON-RPC envelope.

### 1. Configure the server

Use an absolute repository path in your MCP client configuration:

```json
{
  "mcpServers": {
    "organizer-butler": {
      "command": "npm",
      "args": [
        "--prefix",
        "/absolute/path/to/organizer-butler",
        "run",
        "mcp"
      ],
      "env": {
        "ORGANIZER_DOWNLOADS_DIRECTORY": "/path/to/synthetic-inbox",
        "ORGANIZER_ROOT": "/path/to/synthetic-destination",
        "ORGANIZER_DATABASE_PATH": "/path/to/organizer-actions.db"
      }
    }
  }
}
```

Restart the MCP host after changing its configuration. IDs issued by scanning and planning are process-local, so restart the workflow after restarting the server.

### 2. Scan the inbox

Call `scan_files` with an empty object:

```json
{}
```

A successful response contains opaque IDs rather than paths:

```json
{
  "ok": true,
  "files": [
    {
      "fileId": "file_example",
      "filename": "acme-2026-08.pdf",
      "extension": ".pdf",
      "mimeType": "application/pdf",
      "size": 42810,
      "modifiedAt": "2026-08-20T13:24:00.000Z"
    }
  ]
}
```

### 3. Inspect the file

Call `inspect_file` with the returned ID:

```json
{
  "fileId": "file_example"
}
```

Use the bounded `inspection.extraction` and ordered `inspection.ruleEvidence` to reason about a category. Inspection never classifies or mutates the file.

### 4. Submit a controlled classification

Valid areas are `work`, `coding`, `finance`, `health`, `travel`, `job-applications`, `personal`, `other`, and `unknown`.

Valid document types are `invoice`, `receipt`, `statement`, `contract`, `reservation`, `ticket`, `research`, `cv`, `job-description`, `presentation`, `spreadsheet`, `image`, `code`, `archive`, `document`, `installer`, `other`, and `unknown`.

Submit either two concrete values or `unknown` for both values:

```json
{
  "fileId": "file_example",
  "classification": {
    "area": "finance",
    "documentType": "invoice",
    "rationale": "The PDF metadata and invoice filename pattern indicate a vendor invoice."
  }
}
```

`submit_classification_and_preview_file` freshly reinspects the file and returns a move `planId`, an expiry, the exact controlled destination segments, and a conflict state.

### 5. Preview and create missing directories

Call `preview_organization_directories` with the move plan:

```json
{
  "planId": "plan_example"
}
```

This call consumes the move plan even when both directories already exist. If any directory is `missing`, show the exact directory list to the user and obtain explicit approval before continuing:

```json
{
  "directoryPlanId": "directory_plan_example"
}
```

Pass that object to `confirm_organization_directories`, then pass its returned capability to `execute_organization_directories`:

```json
{
  "directoryConfirmationId": "directory_confirm_example"
}
```

Directory execution creates only the two controlled levels, one at a time. It does not move the file.

### 6. Generate a fresh move plan

Because directory preview consumes the original move plan, call `submit_classification_and_preview_file` again with the same reviewed classification. Verify that the fresh plan has `conflict: "none"` and that the displayed destination still matches the user's approval.

If you already know the controlled directories exist, you can skip directory preview and use the initial move plan directly.

### 7. Confirm and execute the move

After explicit user approval, call `confirm_organization_plan`:

```json
{
  "planId": "plan_fresh_example"
}
```

Then call `execute_organization_plan` with the returned one-time confirmation:

```json
{
  "confirmationId": "confirm_example"
}
```

Success returns `status: "completed"`. Reusing a consumed or expired plan fails with a stable structured error. Retrying a completed confirmation returns the same durable result without repeating the filesystem mutation, which lets a caller recover from a lost response safely.

## Tool reference

Every MCP tool rejects unknown input fields and declares an output schema. Successful calls return JSON text and `structuredContent`; controlled failures set `isError` and return `{ "ok": false, "error": { "code", "message" } }` without paths, stack traces, or parser internals.

| Tool | Input | Side effect | Successful payload |
| --- | --- | --- | --- |
| `scan_files` | `{}` | None | `files` with metadata and opaque IDs |
| `inspect_file` | `{ fileId }` | None | Bounded `inspection` and rule evidence |
| `submit_classification_and_preview_file` | `{ fileId, classification }` | Consumes classification capability internally | Fresh move `plan` and conflict state |
| `preview_organization_directories` | `{ planId }` | Consumes the move plan | Two controlled directory statuses and a directory plan |
| `confirm_organization_directories` | `{ directoryPlanId }` | Persists directory authority | Expiring directory confirmation |
| `execute_organization_directories` | `{ directoryConfirmationId }` | Creates missing controlled directories | Completed directory execution |
| `confirm_organization_plan` | `{ planId }` | Persists move authority | Expiring move confirmation |
| `execute_organization_plan` | `{ confirmationId }` | Moves exactly one file | Completed move execution |

No tool accepts a path, destination, overwrite flag, arbitrary taxonomy value, model option, or credential.

### Common errors

| Code | Meaning | Recovery |
| --- | --- | --- |
| `FILE_CHANGED` | The file changed after scanning | Scan again and restart the workflow |
| `PLAN_EXPIRED` | The preview exceeded its configured lifetime | Submit the classification again |
| `PLAN_ALREADY_USED` | A one-time move plan was already consumed | Submit the classification again |
| `PLAN_CONFLICT` | The destination became occupied | Resolve the existing target manually, then re-scan |
| `EXECUTION_DESTINATION_UNAVAILABLE` | Controlled destination directories do not exist | Run the directory workflow, then create a fresh move plan |
| `EXECUTION_CROSS_FILESYSTEM` | Inbox and destination are on different devices | Choose folders on the same filesystem |
| `EXECUTION_STORAGE_FAILED` | Durable authority could not be stored or recovered | Check database permissions, locks, and available storage |

See [`src/domain/error.ts`](src/domain/error.ts) for the complete stable error-code union.

## Inspection support

Inspection is extension-driven and intentionally narrower than full document rendering.

| Format | Bounded extraction | Deliberately excluded |
| --- | --- | --- |
| TXT, Markdown | Text excerpt | Content beyond the character limit |
| CSV | Complete quote validation and row count; bounded headers, rows, columns, and fields | Unbounded retained data |
| JSON | Structural preview with exact number lexemes | Duplicate decoded keys and excessive nesting |
| ZIP | Central-directory metadata | Extraction and member decompression |
| PDF | Version, page count, allowlisted document metadata | Text, rendering, attachments, JavaScript, and XMP |
| XLSX | Workbook metadata and bounded scalar cell previews | Formula interpretation, charts, images, macros, and embedded files |
| DOCX | Core properties and direct body-paragraph text | Tables, headers, comments, images, macros, and embedded files |
| PPTX | Core properties and direct shape text | Notes, media, charts, macros, and embedded files |
| JPEG | Dimensions and allowlisted EXIF text for supported baseline images | Pixel decoding, GPS, thumbnails, and arbitrary EXIF |
| PNG | Dimensions and allowlisted uncompressed text | Pixel inflation, animation, and unknown critical chunks |

Unsupported formats retain safe file metadata and deterministic filename or extension evidence, but return an unsupported extraction rather than attempting a broad parser fallback.

## Security and privacy

Organizer Butler's core assumes filenames, file contents, model output, capabilities, and filesystem state can all become stale or hostile.

- Scanning is non-recursive and accepts regular files only.
- Hidden files, partial downloads, symbolic links, directories, macOS app bundles, and non-regular entries are skipped.
- Opaque file identities are revalidated against device, inode, size, and modification time.
- Destination segments come from fixed local mappings, never from a model response.
- Destination ancestry is checked for containment and symlinks before planning and execution.
- Existing targets are never overwritten, merged, or automatically renamed.
- Moves use exclusive same-filesystem hard-link creation followed by source unlink; there is no copy-and-delete fallback.
- Directory creation has separate preview, confirmation, execution, and conservative recovery boundaries.
- SQLite uses durable records and owner-scoped recovery leases for interrupted confirmed operations.
- Public MCP responses omit paths, filesystem identities, internal capabilities, stack traces, and parser details.

Local-first does not mean no data can ever leave the device. If desktop AI is enabled, filenames and bounded inspection content are sent to the signed-in Codex service as described in [AI classification](#ai-classification). SQLite also stores source and destination paths locally because durable recovery requires them.

No dedicated security-reporting channel is configured yet. Do not put file contents, local paths, credentials, or database records in a public issue; contact the repository owner through GitHub before sharing sensitive details.

## Architecture

```text
Electron renderer -> typed preload IPC -> Electron main --+
                                                            +-> OrganizerApplication -> core -> filesystem + SQLite
MCP host ---------> stdio MCP adapter ---------------------+

CLI --------------> scan adapter -> FileRegistry -> filesystem
```

| Layer | Responsibility | Entry points |
| --- | --- | --- |
| Domain | Shared DTOs, stable errors, and internal resolved-file state | [`src/domain`](src/domain) |
| Core | Scanning, inspection, taxonomy, validation, planning, execution, and persistence | [`src/core`](src/core) |
| Application | Shared lifecycle, recovery, admission, and orchestration | [`src/application/organizerApplication.ts`](src/application/organizerApplication.ts) |
| Desktop | Electron main process, sandboxed renderer, typed preload, and Codex runtime | [`src/desktop`](src/desktop) |
| MCP | Strict stdio tool adapter | [`src/mcp`](src/mcp) |
| CLI | Scan-only JSON adapter | [`src/cli`](src/cli) |

The renderer runs without Node integration and communicates through a narrow, context-isolated preload API. The current prototype keeps synchronous SQLite and parser work in Electron main; moving it to a long-lived utility process remains release hardening work.

## Configuration

The full configuration reference, including every parser and lifecycle bound, is maintained in [`.env.example`](.env.example). Invalid or out-of-range values fail configuration parsing.

| Variable | Default | Purpose |
| --- | --- | --- |
| `ORGANIZER_DOWNLOADS_DIRECTORY` | `~/Downloads` | Non-recursive inbox used by MCP and CLI |
| `ORGANIZER_ROOT` | `~/Downloads` | Controlled destination root used by MCP |
| `ORGANIZER_DATABASE_PATH` | `~/.local/share/organizer-butler/actions.db` | Durable confirmations, recovery, replay, and retention |
| `ORGANIZER_MAX_EXTRACTED_TEXT_LENGTH` | `6000` | Retained TXT and Markdown characters |
| `ORGANIZER_MAX_PLAN_PATH_BYTES` | `4096` | Maximum validated destination path length |
| `ORGANIZER_PLAN_EXPIRY_MS` | `600000` | Move-plan lifetime before confirmation |
| `ORGANIZER_CONFIRMATION_EXPIRY_MS` | `300000` | Move-confirmation lifetime |
| `ORGANIZER_DIRECTORY_PLAN_EXPIRY_MS` | `600000` | Directory-plan lifetime |
| `ORGANIZER_DIRECTORY_CONFIRMATION_EXPIRY_MS` | `300000` | Directory-confirmation lifetime |

Desktop differences:

- Folder choices come from native dialogs and are not initialized from inbox or root environment variables.
- The database is stored at Electron's per-user `userData/actions.db` path.
- AI consent is stored in `userData/settings.json`.
- Codex state is isolated under `userData/codex`.
- Format inspection and capability lifetime limits still come from the environment.

## Development

| Command | Purpose |
| --- | --- |
| `npm run dev` | Start Electron through Forge and Vite |
| `npm run dev:cli` | Run the scan-only CLI; defaults to `scan` |
| `npm run organize` | Run the explicit CLI `scan` command |
| `npm run mcp` | Start the TypeScript stdio MCP server |
| `npm run typecheck` | Run TypeScript without emitting files |
| `npm test` | Run the Node test suite through `tsx` |
| `npm run package` | Build an unpacked Electron application |
| `npm run make` | Create configured platform artifacts |
| `npm run smoke:package` | Smoke-test the hard-coded macOS arm64 package path |
| `npm run verify` | Run typechecking, tests, and unpacked packaging |

At this revision, `npm test` runs 212 automated tests. The suite covers the scanner, format inspectors, taxonomy and rules, path safety, classification capability, planning, SQLite migration and recovery, MCP behavior, application orchestration, and desktop contracts. Real ChatGPT authentication, packaged classifier behavior, installers, and native Windows filesystem semantics still require manual or end-to-end coverage.

### Project structure

```text
src/
|-- application/   Shared orchestration and classifier adapters
|-- cli/           Scan-only command-line entry point
|-- config/        Environment parsing and defaults
|-- core/          Safety-critical scanner, inspectors, taxonomy, and planning
|-- desktop/       Electron main, preload, renderer, settings, and Codex runtime
|-- domain/        Public path-free types and stable errors
`-- mcp/           MCP server and stdio entry point
tests/             Node test suite and safety fixtures
```

### Contribution checklist

1. Start from a synthetic inbox; never use personal files for development verification.
2. Keep public contracts path-free unless a reviewed product requirement explicitly changes that boundary.
3. Add tests for success, malformed input, stale state, collisions, and limit enforcement.
4. Update this README when commands, public tools, configuration, or user-visible behavior changes.
5. Run `npm run typecheck` and `npm test` before opening a pull request.
6. Use `npm run verify` when a change affects the packaged desktop application.

## Troubleshooting and FAQ

### Why did the scan return no files?

The scanner reads only the selected folder's top level. It skips hidden entries, temporary downloads, symlinks, directories, `.app` bundles, non-regular entries, files that disappear during metadata lookup, and unreadable entries.

### Does the application require AI or an API key?

No. Manual categorization works without AI. Optional desktop suggestions use official ChatGPT authentication through Codex, not `OPENAI_API_KEY`.

### Why did my ID stop working?

File IDs and unconfirmed plans are process-local. Restarting the MCP server, changing a desktop folder, or changing a tracked file invalidates them. Scan again and restart the workflow. Already persisted confirmation IDs have separate recovery and replay rules.

### Why can't Organizer Butler create my destination root?

The destination root is outside the tool's creation authority and must already exist. Organizer Butler can create only the missing area and document-type levels derived from its fixed taxonomy.

### Why was a move rejected even though the preview was clear?

Organizer Butler revalidates state at confirmation and execution. The file or destination may have changed, the capability may have expired, or a target may now exist. MCP callers should use the stable error code to choose a recovery action; the desktop app displays only a sanitized message. Do not retry a consumed plan blindly. For the current desktop direct-move issue, use the documented MCP workflow.

### Can Organizer Butler move files to another drive?

No. Cross-filesystem moves fail safely. A future copy-and-delete workflow would need separate integrity checks, preview, consent, durability, and recovery semantics.

### Does `.env.example` load automatically?

No. It is a reference. Export variables in your shell or configure them in the process launcher.

### Is Linux supported?

No desktop Linux target is currently configured. Forge makers cover macOS and Windows, but Windows remains unverified and unsigned. Source-level CLI or MCP behavior on another platform does not imply supported desktop packaging or filesystem semantics.

## Known limitations

- The product is a prototype, not a signed or notarized release.
- Desktop organization is one file at a time; there is no batch move, watcher, scheduler, tray mode, or per-file classification retry.
- The current desktop direct-move issue is documented in the [Desktop guide](#desktop-guide).
- Folder selections must be repeated after relaunch.
- There is no overwrite, automatic rename, merge, copy-and-delete fallback, broad audit-history UI, or undo.
- PDF inspection is metadata-only; Office document previews intentionally support a narrow content subset.
- Synchronous parsing and SQLite work can briefly affect Electron main-process responsiveness.
- macOS signing, notarization, auto-update, Windows signing, and native Windows verification remain release work.

## Roadmap and history

The previous README has been preserved in full as [`ROADMAP.md`](ROADMAP.md). It contains the detailed implementation journal, design rationale, historical test counts, completed milestones, and release-hardening backlog. Some entries describe earlier repository states; use this README for the current developer-facing contract.

## License

This public repository does not currently declare an open-source license. The `private` package setting prevents accidental npm publication; it does not grant permission to copy, modify, or distribute the code. Repository visibility alone does not replace a license.
