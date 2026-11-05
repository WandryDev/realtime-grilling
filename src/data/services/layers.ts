import { Layer } from "effect";

import { CallRecordsData } from "./call-records";
import { CallsData } from "./calls";
import { DataEvents } from "./data-events";
import { MockDatabase } from "./mock-database";
import { PeopleData } from "./people";
import { ProjectsData } from "./projects";
import { ProposalsData } from "./proposals";
import { SettingsData } from "./settings";
import { ProjectSourcesData } from "./sources";
import { SummaryData } from "./summaries";

/*
 * The data services as one layer per environment, for `src/effect/runtime.ts`
 * and the contract tests. The mock set shares one MockDatabase and exposes
 * it, so tests and `reset*` can reach the demo records.
 */

export const DataLayerTauri = Layer.mergeAll(
  CallRecordsData.layerTauri,
  CallsData.layerTauri,
  DataEvents.layerTauri,
  PeopleData.layerTauri,
  ProjectsData.layerTauri,
  ProjectSourcesData.layerTauri,
  ProposalsData.layerTauri,
  SettingsData.layerTauri,
  SummaryData.layerTauri
);

export const DataLayerMock = Layer.mergeAll(
  CallRecordsData.layerMock,
  CallsData.layerMock,
  DataEvents.layerMock,
  PeopleData.layerMock,
  ProjectsData.layerMock,
  ProjectSourcesData.layerMock,
  ProposalsData.layerMock,
  SettingsData.layerMock,
  SummaryData.layerMock
).pipe(Layer.provideMerge(MockDatabase.layer));
