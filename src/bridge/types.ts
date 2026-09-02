export type BrowserMethod =
  | "browser_status"
  | "list_tabs"
  | "get_active_tab"
  | "read_tab"
  | "read_tabs"
  | "search_tabs"
  | "click"
  | "type"
  | "press_key"
  | "scroll"
  | "navigate"
  | "new_tab"
  | "close_tab"
  | "select_option"
  | "chatgpt_worker_submit"
  | "read_chatgpt_worker"
  | "activate_worker_tab"
  | "reload_worker_tab"
  | "resolve_agent_anchor"
  | "open_agent_worker_tab";

export interface NativeRequest {
  type: "request";
  id: string;
  method: BrowserMethod;
  params: Record<string, unknown>;
}

export interface NativeResponse {
  type: "response";
  id: string;
  result?: unknown;
  error?: { code: string; message: string };
}

export interface NativeReady {
  type: "ready";
  extensionVersion: string;
  extensionId: string;
}

export type IncomingNativeMessage = NativeResponse | NativeReady;

export interface TabSummary {
  tabId: number;
  windowId: number;
  index: number;
  title: string;
  url: string;
  active: boolean;
  pinned: boolean;
  discarded: boolean;
  status: string;
  incognito: boolean;
}

export interface PageContent {
  tab: TabSummary;
  page: {
    title: string;
    url: string;
    language: string;
    description: string;
    headings: Array<{ level: number; text: string }>;
    links: Array<{ text: string; href: string }>;
    text: string;
    offset: number;
    returnedCharacters: number;
    totalCharacters: number;
    truncated: boolean;
  };
  security: {
    contentIsUntrusted: true;
    warning: string;
  };
}
