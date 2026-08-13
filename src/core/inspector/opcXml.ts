import path from "node:path";
import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";
import { normalizeOoxmlPartName } from "./ooxmlPackage.js";

export type OpcRelationship = { id: string; type: string; target: string };

export type OpcXmlFailure = "malformed" | "unsupported" | "unsafe-relationship" | "duplicate-part";

export class OpcXmlError extends Error {
  constructor(readonly failure: OpcXmlFailure) {
    super(failure);
  }
}

const CONTENT_TYPES_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/content-types";
const RELATIONSHIPS_NAMESPACE = "http://schemas.openxmlformats.org/package/2006/relationships";

export function parseOpcContentTypes(
  source: Buffer,
  validateContentType?: (contentType: string) => void,
): Map<string, string> {
  const overrides = new Map<string, string>();
  parseOpcXml(source, {
    onOpenTag(tag) {
      if (tag.uri !== CONTENT_TYPES_NAMESPACE) throw new OpcXmlError("unsupported");
      const contentType = opcAttribute(tag, "ContentType");
      if (contentType !== undefined) validateContentType?.(contentType);
      if (tag.local !== "Override") return;
      const partName = opcAttribute(tag, "PartName");
      if (partName === undefined || contentType === undefined || !partName.startsWith("/")) {
        throw new OpcXmlError("malformed");
      }
      const normalized = normalizeOoxmlPartName(partName.slice(1));
      if (overrides.has(normalized)) throw new OpcXmlError("duplicate-part");
      overrides.set(normalized, contentType);
    },
  });
  return overrides;
}

export function parseOpcRelationships(source: Buffer): OpcRelationship[] {
  const relationships: OpcRelationship[] = [];
  const ids = new Set<string>();
  parseOpcXml(source, {
    onOpenTag(tag) {
      if (tag.uri !== RELATIONSHIPS_NAMESPACE) throw new OpcXmlError("unsupported");
      if (tag.local !== "Relationship") return;
      const id = opcAttribute(tag, "Id");
      const type = opcAttribute(tag, "Type");
      const target = opcAttribute(tag, "Target");
      if (id === undefined || type === undefined || target === undefined || ids.has(id)) {
        throw new OpcXmlError("malformed");
      }
      if (opcAttribute(tag, "TargetMode") !== undefined) throw new OpcXmlError("unsafe-relationship");
      ids.add(id);
      relationships.push({ id, type, target });
    },
  });
  return relationships;
}

export function parseOpcXml(
  source: Buffer,
  handlers: {
    onOpenTag: (tag: SaxesTagNS) => void;
    onText?: (text: string) => void;
    onCloseTag?: () => void;
  },
): void {
  let xml: string;
  try {
    xml = new TextDecoder("utf-8", { fatal: true }).decode(source);
  } catch {
    throw new OpcXmlError("malformed");
  }
  if (/^\s*<\?xml[^>]*encoding\s*=\s*["'](?!utf-?8["'])/i.test(xml)) {
    throw new OpcXmlError("unsupported");
  }
  const parser = new SaxesParser({ xmlns: true, position: false });
  parser.on("doctype", () => {
    throw new OpcXmlError("unsupported");
  });
  parser.on("opentag", handlers.onOpenTag);
  if (handlers.onText !== undefined) parser.on("text", handlers.onText);
  if (handlers.onCloseTag !== undefined) parser.on("closetag", handlers.onCloseTag);
  parser.write(xml).close();
}

export function opcAttribute(tag: SaxesTagNS, local: string): string | undefined {
  return Object.values(tag.attributes).find((item: SaxesAttributeNS) => item.uri === "" && item.local === local)?.value;
}

export function opcNamespacedAttribute(
  tag: SaxesTagNS,
  namespaces: ReadonlySet<string>,
  local: string,
): string | undefined {
  return Object.values(tag.attributes).find(
    (item: SaxesAttributeNS) => namespaces.has(item.uri) && item.local === local,
  )?.value;
}

export function opcRelationshipPartName(partName: string): string {
  const directory = path.posix.dirname(partName);
  return `${directory === "." ? "" : `${directory}/`}_rels/${path.posix.basename(partName)}.rels`;
}

export function resolveOpcRelationshipTarget(sourcePart: string, target: string): string {
  if (
    target.length === 0 ||
    target.includes("\\") ||
    target.startsWith("/") ||
    target.includes("?") ||
    target.includes("#") ||
    /^[a-zA-Z][a-zA-Z\d+.-]*:/.test(target)
  ) {
    throw new OpcXmlError("unsafe-relationship");
  }
  let decoded: string;
  try {
    decoded = decodeURIComponent(target);
  } catch {
    throw new OpcXmlError("unsafe-relationship");
  }
  if (decoded.includes("\\") || decoded.startsWith("/") || decoded.includes("\0") || decoded.split("/").includes("..")) {
    throw new OpcXmlError("unsafe-relationship");
  }
  const base = sourcePart === "" ? "" : path.posix.dirname(sourcePart);
  const normalized = `${base}/${decoded}`.split("/").filter((segment) => segment !== "" && segment !== ".");
  if (normalized.length === 0) throw new OpcXmlError("unsafe-relationship");
  return normalizeOoxmlPartName(normalized.join("/"));
}
