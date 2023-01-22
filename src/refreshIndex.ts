import { MultiGraph } from "graphology";
import { debug, error } from "loglevel";
import { normalizePath, Notice, Pos, TFile, TFolder } from "obsidian";
import { addCSVCrumbs, getCSVRows } from "./AlternativeHierarchies/CSVCrumbs";
import { addDataviewNotesToGraph } from "./AlternativeHierarchies/DataviewNotes";
import { addFolderHierarchyNotesToGraph } from "./AlternativeHierarchies/FolderHierarchy";
import { addDateNotesToGraph } from "./AlternativeHierarchies/DateNotes";
import { addDendronNotesToGraph } from "./AlternativeHierarchies/DendronNotes";
import { addFolderNotesToGraph } from "./AlternativeHierarchies/FolderNotes";
import {
  addHNsToGraph,
  getHierarchyNoteItems
} from "./AlternativeHierarchies/HierarchyNotes/HierarchyNotes";
import {
  addJugglLinksToGraph,
  getJugglLinks
} from "./AlternativeHierarchies/JugglLinks";
import { addLinkNotesToGraph } from "./AlternativeHierarchies/LinkNotes";
import { addRegexNotesToGraph } from "./AlternativeHierarchies/RegexNotes";
import { addTagNotesToGraph } from "./AlternativeHierarchies/TagNotes";
import { addTraverseNotesToGraph } from "./AlternativeHierarchies/TraverseNotes";
import {
  BC_ALTS,
  BC_DV_NOTE,
  BC_FOLDER_NOTE, BC_LINK_NOTE,
  BC_REGEX_NOTE,
  BC_TAG_NOTE,
  BC_TRAVERSE_NOTE,
  dropHeaderOrAlias,
  splitLinksRegex
} from "./constants";
import type {
  dvFrontmatterCache,
  dvLink,
  RawValue
} from "./interfaces";
import type BCPlugin from "./main";
import { addAuntsUncles, addCousins, addSiblingsFromSameParent, addSiblingsParentIsParent, addStructuralEquivalenceSiblings } from "./Relations";
import {
  addNodesIfNot,
  buildObsGraph,
  getReflexiveClosure,
  getSourceOrder,
  getTargetOrder,
  populateMain
} from "./Utils/graphUtils";
import { iterateHiers } from "./Utils/HierUtils";
import {
  getBaseFromMDPath,
  getDVApi,
  getDVBasename
} from "./Utils/ObsidianUtils";
import { drawTrail } from "./Views/TrailView";

function getDVMetadataCache(plugin: BCPlugin) {
  const { db } = plugin;
  const api = getDVApi(plugin);

  db.start1G("getDVMetadataCache");
  const frontms = api.pages().values
  db.end1G({ frontms });

  return frontms;
}

function getObsMetadataCache(plugin: BCPlugin, files: TFile[]) {
  const { db } = plugin;
  db.start1G("getObsMetadataCache");

  const frontms: dvFrontmatterCache[] = files.map((file) => {
    const { frontmatter } = app.metadataCache.getFileCache(file);
    return frontmatter ? { file, ...frontmatter } : { file };
  });

  db.end1G({ frontms });
  return frontms;
}

const isDVProxy = (item: RawValue) => typeof item.defaultComparator === "function"

/**
 * Keep unwrapping a proxied item until it isn't one anymore
 * @param  {RawValue} item
 */
function unproxy(item: RawValue) {
  const unproxied = [];
  const queue = [item];

  while (queue.length) {
    const currItem = queue.shift();

    if (isDVProxy(currItem)) queue.push(...currItem.values);
    else unproxied.push(currItem);
  }
  return unproxied;
}


/**
 * Given a `dvCache[field]` value, parse the link(s) out of it
 * @param {string | string[] | string[][] | dvLink | dvLink[] | Pos | TFile} value
 */
function parseFieldValue(
  value: string | string[] | string[][] | dvLink | dvLink[] | Pos | TFile
) {
  if (!value) return [];


  const parsed: string[] = [];
  try {

    if (typeof value === "string") {
      const splits = value.match(splitLinksRegex);

      if (splits !== null) {
        const linkNames = splits.map((link) => getBaseFromMDPath(link.match(dropHeaderOrAlias)[1]));
        parsed.push(...linkNames);
      }
    } else {
      const rawValues: RawValue[] = [value].flat(4);
      debug(...rawValues);

      rawValues.forEach((rawItem) => {
        if (!rawItem) return;

        const unProxied = unproxy(rawItem);
        unProxied.forEach((value) => {
          if (typeof value === "string" || typeof value === "number") {
            const rawAsString = value.toString();
            const splits = rawAsString.match(splitLinksRegex);
            if (splits !== null) {
              const strs = splits.map((link) =>
                getBaseFromMDPath(link.match(dropHeaderOrAlias)[1])
              );
              parsed.push(...strs);
            } else {
              const basename = getBaseFromMDPath(rawAsString);
              parsed.push(basename.split("#")[0].split("|")[0]);
            }
          } else if (value.path !== undefined) {
            const basename = getBaseFromMDPath(value.path);
            if (basename !== undefined) parsed.push(basename);
          }
        });
      });
    }
    return parsed;
  } catch (err) {
    error(err);
    return parsed;
  }
}

export async function buildMainG(plugin: BCPlugin): Promise<MultiGraph> {
  const mainG = new MultiGraph();
  try {
    const { settings, db } = plugin;
    const { userHiers, CSVPaths, parseJugglLinksWithoutJuggl, hierarchyNotes } =
      settings;
    db.start2G("initGraphs");

    if (userHiers.length === 0) {
      db.end2G();
      new Notice("You do not have any Breadcrumbs hierarchies set up.");
      return mainG;
    }

    const files = app.vault.getMarkdownFiles();
    const dvQ = app.plugins.enabledPlugins.has("dataview");

    let frontms: dvFrontmatterCache[] = dvQ
      ? getDVMetadataCache(plugin)
      : getObsMetadataCache(plugin, files);

    // if (frontms.some((frontm) => frontm === undefined)) {
    //   await wait(2000);
    //   frontms = dvQ
    //     ? getDVMetadataCache(plugin)
    //     : getObsMetadataCache(plugin, files);
    // }

    const CSVRows = CSVPaths !== "" ? await getCSVRows(plugin) : [];

    const eligableAlts: { [altField: string]: dvFrontmatterCache[] } = {};
    BC_ALTS.forEach((alt) => (eligableAlts[alt] = []));

    db.start2G("addFrontmatterToGraph");
    frontms.forEach((page) => {
      BC_ALTS.forEach((alt) => {
        if (page[alt] !== undefined && page[alt] !== null)
          eligableAlts[alt].push(page);
      });

      const basename = getDVBasename(page.file);
      const sourceOrder = getSourceOrder(page);

      iterateHiers(userHiers, (hier, dir, field) => {
        const values = parseFieldValue(page[field]);

        values.forEach((target) => {
          if (target.startsWith("<%") || target.startsWith("{{")) return;
          const targetOrder = getTargetOrder(frontms, target);

          populateMain(
            settings,
            mainG,
            basename,
            field,
            target,
            sourceOrder,
            targetOrder
          );
        });
        if (CSVRows.length) addCSVCrumbs(mainG, CSVRows, dir, field);
      });
    });

    db.end2G();

    // SECTION  Juggl Links
    const jugglLinks =
      app.plugins.plugins.juggl || parseJugglLinksWithoutJuggl
        ? await getJugglLinks(plugin, files)
        : [];

    if (jugglLinks.length)
      addJugglLinksToGraph(settings, jugglLinks, frontms, mainG);

    // !SECTION  Juggl Links

    db.start2G("Alternative Hierarchies");
    // SECTION  Hierarchy Notes
    db.start2G("Hierarchy Notes");

    if (hierarchyNotes.length) {
      for (const noteOrFolder of hierarchyNotes) {
        if (noteOrFolder.endsWith("/")) {
          const folder = app.vault.getAbstractFileByPath(
            normalizePath(noteOrFolder)
          );

          if (!(folder instanceof TFolder)) continue;
          for (const child of folder.children) {
            if (child instanceof TFile) {
              addHNsToGraph(
                settings,
                await getHierarchyNoteItems(child),
                mainG
              );
            }
          }
        } else {
          const file = app.metadataCache.getFirstLinkpathDest(noteOrFolder, "");
          if (file)
            addHNsToGraph(
              settings,
              await getHierarchyNoteItems(file),
              mainG
            );
        }
      }
    }

    db.end2G();
    // !SECTION  Hierarchy Notes

    db.start2G("Folder Notes");
    addFolderNotesToGraph(plugin, eligableAlts[BC_FOLDER_NOTE], frontms, mainG);
    db.end2G();
    db.start2G("Tag Notes");
    addTagNotesToGraph(plugin, eligableAlts[BC_TAG_NOTE], frontms, mainG);
    db.end2G();
    db.start2G("Link Notes");
    addLinkNotesToGraph(plugin, eligableAlts[BC_LINK_NOTE], frontms, mainG);
    db.end2G();
    db.start2G("Regex Notes");
    addRegexNotesToGraph(plugin, eligableAlts[BC_REGEX_NOTE], frontms, mainG);
    db.end2G();
    // plugin.addNamingSystemNotesToGraph(frontms, mainG);
    db.start2G("Traverse Notes");
    addTraverseNotesToGraph(
      plugin,
      eligableAlts[BC_TRAVERSE_NOTE],
      mainG,
      buildObsGraph()
    );
    db.end2G();
    db.start2G("Dendron Notes");
    addDendronNotesToGraph(plugin, frontms, mainG);
    db.end2G();
    db.start2G("Folder Hierarchy Notes");
    addFolderHierarchyNotesToGraph(plugin, frontms, mainG);
    db.end2G();
    db.start2G("Dataview Notes");
    addDataviewNotesToGraph(plugin, eligableAlts[BC_DV_NOTE], frontms, mainG);
    db.end2G();
    db.start2G("Date Notes");
    addDateNotesToGraph(plugin, frontms, mainG);
    db.end2G();

    db.end2G();

    files.forEach((file) => addNodesIfNot(mainG, [file.basename]));
    db.end2G("graphs inited", { mainG });
    return mainG;
  } catch (err) {
    error(err);
    plugin.db.end2G();
    return mainG;
  }
}

export function buildClosedG(plugin: BCPlugin) {
  const { mainG, settings } = plugin;
  const {
    userHiers,
    impliedRelations: {
      sameParentIsSibling,
      parentsSiblingsIsParents,
      cousinsIsSibling,
      siblingsSiblingIsSibling,
      siblingsParentIsParent,
    },
  } = settings;
  let closedG = getReflexiveClosure(mainG, userHiers);

  if (sameParentIsSibling) addSiblingsFromSameParent(closedG, settings);
  if (siblingsParentIsParent) addSiblingsParentIsParent(closedG);
  if (parentsSiblingsIsParents) addAuntsUncles(closedG);
  if (cousinsIsSibling) addCousins(closedG);
  if (siblingsSiblingIsSibling) addStructuralEquivalenceSiblings(closedG);

  return closedG;
}

export async function refreshIndex(plugin: BCPlugin) {
  if (!plugin.activeLeafChange) plugin.registerActiveLeafChangeEvent();
  if (!plugin.layoutChange) plugin.registerLayoutChangeEvent();

  plugin.mainG = await buildMainG(plugin);
  plugin.closedG = buildClosedG(plugin);

  for (const { type } of plugin.VIEWS)
    await plugin.getActiveTYPEView(type)?.draw();

  if (plugin.settings.showBCs) await drawTrail(plugin);
  if (plugin.settings.showRefreshNotice) new Notice("BC Index refreshed");
}
