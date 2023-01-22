import type { MultiGraph } from "graphology";
import { BC_IGNORE, BC_IGNORE_DENDRON } from "../constants";
import type { dvFrontmatterCache } from "../interfaces";
import type BCPlugin from "../main";
import {
  populateMain,
} from "../Utils/graphUtils";

const getParent = (dendron: string) => {
  let parent = dendron.split("/").slice(0, -1).join("/");
  // If it's empty, no parent
  // Otherwise, return path + ".md"
  if (parent === "") {
    return "";
  } else {
    return parent + ".md";
  }
}

export function addFolderHierarchyNotesToGraph(
  plugin: BCPlugin,
  frontms: dvFrontmatterCache[],
  mainG: MultiGraph
) {
  const { settings } = plugin;
  const { addFolderHierarchyNotes, folderHierarchyNoteField } = settings;
  if (!addFolderHierarchyNotes) return;

  for (const frontm of frontms) {
    if (frontm[BC_IGNORE_DENDRON] || frontm[BC_IGNORE]) continue;

    let curr = frontm.file.path;
    let parent = getParent(curr);

    while (parent !== "") {
      const parentFile = frontms.find(
        (fm) => fm.file.path === parent
      );

      // !parentFile implies a "stub"
      // @ts-ignore
      if (!parentFile || parentFile[BC_IGNORE_DENDRON] !== true) {
        populateMain(
          settings,
          mainG,
          curr,
          folderHierarchyNoteField,
          parent,
          9999,
          9999,
          true
        );
      }
      curr = parent;
      parent = getParent(parent);
    }
  }
}