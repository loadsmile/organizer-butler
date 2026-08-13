import { createReadStream } from "node:fs";
import { OrganizerError } from "../../domain/error.js";
import type { CsvExtraction, MalformedCsvExtraction } from "../../domain/inspection.js";

type CsvInspectionConfig = {
  maxSampledRows: number;
  maxColumns: number;
  maxFieldLength: number;
};

type ParserState = "start" | "unquoted" | "quoted" | "afterQuote";

export async function inspectCsv(
  filePath: string,
  config: CsvInspectionConfig,
): Promise<CsvExtraction | MalformedCsvExtraction> {
  let state: ParserState = "start";
  let field = "";
  let fieldLength = 0;
  let row: string[] = [];
  let recordStarted = false;
  let firstCharacter = true;
  let skipLineFeed = false;
  let headers: string[] = [];
  const sampledRows: string[][] = [];
  let recordCount = 0;
  let columnsTruncated = false;
  let fieldsTruncated = false;

  const appendCharacter = (character: string): void => {
    recordStarted = true;
    fieldLength += 1;
    if (fieldLength <= config.maxFieldLength) {
      field += character;
    } else {
      fieldsTruncated = true;
    }
  };

  const finishField = (): void => {
    if (row.length < config.maxColumns) {
      row.push(field);
    } else {
      columnsTruncated = true;
    }
    field = "";
    fieldLength = 0;
  };

  const finishRecord = (): void => {
    finishField();
    if (recordCount === 0) {
      headers = row;
    } else if (sampledRows.length < config.maxSampledRows) {
      sampledRows.push(row);
    }
    recordCount += 1;
    row = [];
    recordStarted = false;
    state = "start";
  };

  try {
    const stream = createReadStream(filePath, { encoding: "utf8" });
    for await (const chunk of stream) {
      for (const originalCharacter of chunk) {
        if (firstCharacter) {
          firstCharacter = false;
          if (originalCharacter === "\uFEFF") {
            continue;
          }
        }

        if (skipLineFeed) {
          skipLineFeed = false;
          if (originalCharacter === "\n") {
            continue;
          }
        }

        const isLineEnding = originalCharacter === "\n" || originalCharacter === "\r";
        if (state === "quoted") {
          if (originalCharacter === '"') {
            state = "afterQuote";
          } else {
            appendCharacter(originalCharacter);
          }
          continue;
        }

        if (state === "afterQuote") {
          if (originalCharacter === '"') {
            appendCharacter(originalCharacter);
            state = "quoted";
          } else if (originalCharacter === ",") {
            finishField();
            recordStarted = true;
            state = "start";
          } else if (isLineEnding) {
            finishRecord();
            skipLineFeed = originalCharacter === "\r";
          } else {
            return malformedCsv();
          }
          continue;
        }

        if (isLineEnding) {
          finishRecord();
          skipLineFeed = originalCharacter === "\r";
        } else if (originalCharacter === ",") {
          finishField();
          recordStarted = true;
          state = "start";
        } else if (originalCharacter === '"') {
          if (state !== "start") {
            return malformedCsv();
          }
          recordStarted = true;
          state = "quoted";
        } else {
          appendCharacter(originalCharacter);
          state = "unquoted";
        }
      }
    }
  } catch (error) {
    throw new OrganizerError("INSPECTION_FAILED", "The file could not be read for inspection.", {
      cause: error,
    });
  }

  if (state === "quoted") {
    return malformedCsv();
  }
  if (recordStarted || fieldLength > 0 || row.length > 0 || state === "afterQuote") {
    finishRecord();
  }

  const totalRowCount = Math.max(0, recordCount - 1);
  return {
    status: "extracted",
    format: "csv",
    headers,
    sampledRows,
    sampledRowCount: sampledRows.length,
    totalRowCount,
    rowsTruncated: totalRowCount > sampledRows.length,
    columnsTruncated,
    fieldsTruncated,
  };
}

function malformedCsv(): MalformedCsvExtraction {
  return { status: "malformed", format: "csv", reason: "MALFORMED_CSV" };
}
