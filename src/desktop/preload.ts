import { contextBridge, ipcRenderer } from "electron";
import {
  desktopChannels,
  type OrganizerDesktopApi,
} from "./contracts.js";

const api: OrganizerDesktopApi = {
  bootstrap: () => ipcRenderer.invoke(desktopChannels.bootstrap),
  chooseFolder: (kind) => ipcRenderer.invoke(desktopChannels.chooseFolder, kind),
  setAiConsent: (enabled) => ipcRenderer.invoke(desktopChannels.setAiConsent, { enabled }),
  codexLogin: () => ipcRenderer.invoke(desktopChannels.codexLogin),
  codexLogout: () => ipcRenderer.invoke(desktopChannels.codexLogout),
  scan: () => ipcRenderer.invoke(desktopChannels.scan),
  inspect: (fileId) => ipcRenderer.invoke(desktopChannels.inspect, { fileId }),
  classify: (fileId) => ipcRenderer.invoke(desktopChannels.classify, { fileId }),
  previewMove: (input) => ipcRenderer.invoke(desktopChannels.previewMove, input),
  createDirectories: (input) => ipcRenderer.invoke(desktopChannels.createDirectories, input),
  executeMove: (planId) => ipcRenderer.invoke(desktopChannels.executeMove, { planId }),
};

contextBridge.exposeInMainWorld("organizer", Object.freeze(api));
