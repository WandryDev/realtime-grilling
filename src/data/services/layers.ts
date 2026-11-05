import { Layer } from "effect";

import { CallsData } from "./calls";
import { DataEvents } from "./data-events";
import { MockDatabase } from "./mock-database";
import { PeopleData } from "./people";
import { ProjectsData } from "./projects";
import { SettingsData } from "./settings";
import { ProjectSourcesData } from "./sources";

/*
 * The data services as one layer per environment, for `src/effect/runtime.ts`
 * and the contract tests. The mock set shares one MockDatabase and exposes
 * it, so tests and `reset*` can reach the demo records.
 */

export const DataLayerTauri = Layer.mergeAll(
  CallsData.layerTauri,
  DataEvents.layerTauri,
  PeopleData.layerTauri,
  ProjectsData.layerTauri,
  ProjectSourcesData.layerTauri,
  SettingsData.layerTauri
);

export const DataLayerMock = Layer.mergeAll(
  CallsData.layerMock,
  DataEvents.layerMock,
  PeopleData.layerMock,
  ProjectsData.layerMock,
  ProjectSourcesData.layerMock,
  SettingsData.layerMock
).pipe(Layer.provideMerge(MockDatabase.layer));
