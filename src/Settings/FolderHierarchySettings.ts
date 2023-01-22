import { DropdownComponent, Notice, Setting } from "obsidian";
import { refreshIndex } from "../refreshIndex";
import { DEFAULT_SETTINGS, MATRIX_VIEW } from "../constants";
import type BCPlugin from "../main";
import { getFields } from "../Utils/HierUtils";
import { fragWithHTML, subDetails } from "./BreadcrumbsSettingTab";

export function addFolderHierarchySettings(
  plugin: BCPlugin,
  alternativeHierarchyDetails: HTMLDetailsElement
) {
  const { settings } = plugin;
  const { userHiers } = settings;
  const fields = getFields(userHiers);
  const folderHierarchyDetails = subDetails(
    "Folder Hierarchy Notes",
    alternativeHierarchyDetails
  );

  new Setting(folderHierarchyDetails)
    .setName("Add Folder Hierarchy notes to graph")
    .setDesc(
      fragWithHTML(
        "for a file 'focus/Research/babble/notes.md', creates the hierarchy focus > focus/Research > focus/Research/babble > focus/Research/babble/notes"
      )
    )
    .addToggle((toggle) =>
      toggle.setValue(settings.addFolderHierarchyNotes).onChange(async (value) => {
        settings.addFolderHierarchyNotes = value;
        await plugin.saveSettings();
      })
    );

  new Setting(folderHierarchyDetails)
    .setName("Folder Hierarchy Note Field")
    .setDesc("Which field should Breadcrumbs use for Folder Hierarchy notes?")
    .addDropdown((dd: DropdownComponent) => {
      fields.forEach((field) => dd.addOption(field, field));
      dd.setValue(settings.folderHierarchyNoteField);

      dd.onChange(async (value) => {
        settings.dendronNoteField = value;
        await plugin.saveSettings();
        await refreshIndex(plugin);
      });
    });
}
