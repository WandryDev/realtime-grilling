import type { Account, BrowseNode } from "@/bindings";

/*
 * The Outline of the browser demo (`Connectors.layerMock`): the Pixel
 * Agency team with four collections. «Телемедиа» has 12 documents, one of
 * them only a title (no text); «Архив» has 340, over the limit of 200 a
 * project can take.
 */

export const MOCK_OUTLINE_ACCOUNT: Account = {
  host: "https://docs.pixel.agency",
  teamId: "pixel-agency",
  teamName: "Pixel Agency",
  userName: "Дима Капиш",
};

/** A document of the demo Outline. */
export interface MockOutlineDocument {
  children: MockOutlineDocument[];
  /** Only a title: the source is «нет текста». */
  empty?: boolean;
  id: string;
  title: string;
  /** Milliseconds; a sync takes a new version when it grows. */
  updatedAt: number;
}

export interface MockOutlineCollection {
  documents: MockOutlineDocument[];
  id: string;
  title: string;
}

const UPDATED = Date.UTC(2026, 9, 14, 9, 30);

function doc(
  id: string,
  title: string,
  children: MockOutlineDocument[] = [],
  empty = false
): MockOutlineDocument {
  return { children, empty, id, title, updatedAt: UPDATED };
}

const ARCHIVE_SIZE = 340;

export function mockOutlineCollections(): MockOutlineCollection[] {
  return [
    {
      documents: [
        doc("tm-brief", "Бриф Телемедиа", [
          doc("tm-brief-goals", "Цели запуска"),
          doc("tm-brief-audience", "Аудитория"),
        ]),
        doc("tm-api", "API видеосвязи", [
          doc("tm-api-auth", "Авторизация врачей"),
          doc("tm-api-rooms", "Комнаты и записи"),
        ]),
        doc("tm-contract", "Договор и этапы"),
        doc("tm-design", "Дизайн-система"),
        doc("tm-meetings", "Встречи с клиентом", [
          doc("tm-meeting-1", "Встреча 2 октября"),
          doc("tm-meeting-2", "Встреча 9 октября"),
        ]),
        doc("tm-glossary", "Глоссарий", [], true),
      ],
      id: "col-telemedia",
      title: "Телемедиа",
    },
    {
      documents: [
        doc("lapa-brief", "Бриф Лапы"),
        doc("lapa-crm", "Интеграция с CRM", [doc("lapa-crm-api", "API")]),
        doc("lapa-bot", "Бот записи"),
        doc("lapa-prices", "Прайс-лист"),
      ],
      id: "col-lapa",
      title: "Ветклиника Лапа",
    },
    {
      documents: [
        doc("lp-brief", "Бриф Логистик Про"),
        doc("lp-routes", "Маршруты"),
        doc("lp-drivers", "Приложение водителя"),
      ],
      id: "col-logistics",
      title: "Логистик Про",
    },
    {
      documents: Array.from({ length: ARCHIVE_SIZE }, (_, index) =>
        doc(`archive-${index + 1}`, `Заметка ${index + 1}`)
      ),
      id: "col-archive",
      title: "Архив",
    },
  ];
}

export function mockOutlineUrl(kind: "collection" | "doc", id: string) {
  return `${MOCK_OUTLINE_ACCOUNT.host}/${kind}/${id}`;
}

/** A document with all its nested ones. */
export function flattenDocuments(
  documents: MockOutlineDocument[]
): MockOutlineDocument[] {
  return documents.flatMap((item) => [
    item,
    ...flattenDocuments(item.children),
  ]);
}

function documentNode(item: MockOutlineDocument): BrowseNode {
  return {
    children: item.children.map(documentNode),
    documentCount: flattenDocuments([item]).length,
    hasChildren: item.children.length > 0,
    id: item.id,
    kind: "document",
    title: item.title,
    url: mockOutlineUrl("doc", item.id),
  };
}

/** `connector_browse` of the demo Outline. */
export function mockOutlineBrowse(
  collections: MockOutlineCollection[],
  parent: { id: string; kind: "container" | "document" } | null
): BrowseNode[] | undefined {
  if (!parent) {
    return collections.map((collection) => ({
      children: [],
      documentCount: flattenDocuments(collection.documents).length,
      hasChildren: collection.documents.length > 0,
      id: collection.id,
      kind: "container",
      title: collection.title,
      url: mockOutlineUrl("collection", collection.id),
    }));
  }
  if (parent.kind === "container") {
    return collections
      .find((collection) => collection.id === parent.id)
      ?.documents.map(documentNode);
  }
  for (const collection of collections) {
    const found = flattenDocuments(collection.documents).find(
      (item) => item.id === parent.id
    );
    if (found) {
      return found.children.map(documentNode);
    }
  }
}
