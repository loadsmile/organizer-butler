import { areaDisplayNames, areas } from "./areas.js";
import { documentTypeDisplayNames, documentTypes } from "./documentTypes.js";

export function getTaxonomy() {
  return {
    areas: areas.map((id) => ({ id, displayName: areaDisplayNames[id] })),
    documentTypes: documentTypes.map((id) => ({ id, displayName: documentTypeDisplayNames[id] })),
  };
}
