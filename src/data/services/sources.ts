import { Context, Effect, Layer } from "effect";

import {
  commands,
  type ProjectSource,
  type SourceAddOutcome,
  type SourceAddResult,
} from "@/bindings";
import { type BackendError, call } from "@/effect/tauri";

import { compareIds, invalid, MockDatabase, notFound } from "./mock-database";

/*
 * Documents of a project from the manager's computer (project-sources
 * spec). Rust copies each file into the app data and reads its text;
 * the screens see the name, the size and whether the text could be read.
 * Every write sends the project's `DataChanged`: its brief is built from
 * the documents.
 *
 * `layerMock` keeps the contract in memory. It has no files to read, so it
 * makes the result up from the name: the extension decides whether the
 * file is taken, "скан" in the name gives a PDF without text, "битый" a
 * file that can't be read. The same name in a project is the same content.
 */
export class ProjectSourcesData extends Context.Service<
  ProjectSourcesData,
  {
    /** The project's documents in the order they were added. */
    readonly list: (
      projectId: string
    ) => Effect.Effect<ProjectSource[], BackendError>;
    /** A result per path, in order: added, a duplicate or rejected. */
    readonly add: (
      projectId: string,
      paths: string[]
    ) => Effect.Effect<SourceAddResult[], BackendError>;
    /** Deletes a document and its copy. */
    readonly remove: (id: string) => Effect.Effect<void, BackendError>;
  }
>()("grill/data/services/ProjectSourcesData") {
  static readonly layerTauri = Layer.succeed(ProjectSourcesData, {
    add: (projectId, paths) =>
      call(() => commands.projectSourcesAdd(projectId, paths)),
    list: (projectId) => call(() => commands.projectSourcesList(projectId)),
    remove: (id) =>
      Effect.asVoid(call(() => commands.projectSourcesRemove(id))),
  });

  static readonly layerMock = Layer.effect(
    ProjectSourcesData,
    Effect.gen(function* () {
      const database = yield* MockDatabase;
      const { tables } = database;

      const projectExists = Effect.fnUntraced(function* (projectId: string) {
        if (!tables.projects.has(projectId)) {
          return yield* notFound(`Проект ${projectId} не найден`);
        }
      });

      const list = Effect.fnUntraced(function* (projectId: string) {
        yield* projectExists(projectId);
        return [...tables.sources.values()]
          .map(({ source }) => source)
          .filter((source) => source.projectId === projectId)
          .sort((a, b) => a.createdAt - b.createdAt || compareIds(a.id, b.id));
      });

      const addOne = Effect.fnUntraced(function* (
        projectId: string,
        name: string
      ): Effect.fn.Return<SourceAddOutcome> {
        const extension = extensionOf(name);
        if (!SUPPORTED.has(extension)) {
          return {
            message: UNSUPPORTED,
            outcome: "rejected",
            reason: "unsupportedType",
          };
        }
        const sha256 = name;
        for (const stored of tables.sources.values()) {
          if (
            stored.source.projectId === projectId &&
            stored.sha256 === sha256
          ) {
            return { outcome: "duplicate", source: stored.source };
          }
        }
        const { id, now } = yield* database.stamp;
        const source: ProjectSource = {
          createdAt: now,
          extension,
          id,
          name,
          projectId,
          size: name.length * MOCK_BYTES_PER_LETTER,
          ...mockExtraction(name),
        };
        tables.sources.set(id, { sha256, source });
        yield* database.emit("project", projectId, projectId, "updated");
        return { outcome: "added", source };
      });

      const add = Effect.fnUntraced(function* (
        projectId: string,
        paths: string[]
      ) {
        yield* projectExists(projectId);
        const results: SourceAddResult[] = [];
        for (const path of paths) {
          const name = fileName(path);
          results.push({
            name,
            path,
            result: yield* addOne(projectId, name),
          });
        }
        return results;
      });

      const remove = Effect.fnUntraced(function* (id: string) {
        const stored = tables.sources.get(id);
        if (!stored) {
          return yield* notFound(`Документ ${id} не найден`);
        }
        // As in Rust: a connector's document leaves with its selection.
        if (stored.source.origin) {
          return yield* invalid(
            "Документ Outline убирается из проекта через выбор в Outline"
          );
        }
        tables.sources.delete(id);
        const { projectId } = stored.source;
        yield* database.emit("project", projectId, projectId, "updated");
      });

      return ProjectSourcesData.of({ add, list, remove });
    })
  );
}

const SUPPORTED = new Set(["md", "txt", "pdf", "docx"]);
const UNSUPPORTED = "Поддерживаются .md, .txt, .pdf и .docx";

const PATH_SEPARATOR = /[\\/]/u;

/** "/Users/dima/ТЗ.docx" → "ТЗ.docx". */
function fileName(path: string) {
  return path.split(PATH_SEPARATOR).at(-1) ?? path;
}

/** "ТЗ.DOCX" → "docx"; "" without an extension. */
function extensionOf(name: string) {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

const MOCK_BYTES_PER_LETTER = 10_240;
const MOCK_CHARS_PER_LETTER = 1200;
const SCAN = /скан|scan/iu;
const BROKEN = /битый|broken/iu;

/** What reading the file would give, made up from its name. */
function mockExtraction(
  name: string
): Pick<ProjectSource, "error" | "status" | "textChars" | "truncated"> {
  if (SCAN.test(name)) {
    return {
      error: "Нет текста: похоже на скан",
      status: "noText",
      textChars: 0,
      truncated: false,
    };
  }
  if (BROKEN.test(name)) {
    return {
      error: "Файл повреждён или не читается",
      status: "failed",
      textChars: 0,
      truncated: false,
    };
  }
  return {
    error: null,
    status: "ready",
    textChars: name.length * MOCK_CHARS_PER_LETTER,
    truncated: false,
  };
}
