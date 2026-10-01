import { ArrowLeft, Bell, Bookmark, Brain, Check, CheckCircle, ChevronRight, Copy, CornerDownRight, createElement, Flag, FolderTree, Funnel, GitBranch, GitFork, Hourglass, Info, KeyRound, LoaderCircle, Maximize2, Mic, Minimize2, Menu, MessageCircle, MoreVertical, NotebookPen, Paperclip, Pin, RotateCcw, Route, ScrollText, SendHorizontal, Server, Settings, Square, SquarePen, Star, Trash2, TriangleAlert, WifiOff, X } from "lucide";

const iconNodes = {
  "arrow-left": ArrowLeft,
  bell: Bell,
  bookmark: Bookmark,
  brain: Brain,
  check: Check,
  "circle-check": CheckCircle,
  "chevron-right": ChevronRight,
  copy: Copy,
  "corner-down-right": CornerDownRight,
  flag: Flag,
  "folder-tree": FolderTree,
  funnel: Funnel,
  "git-branch": GitBranch,
  "git-fork": GitFork,
  info: Info,
  hourglass: Hourglass,
  "key-round": KeyRound,
  "loader-circle": LoaderCircle,
  menu: Menu,
  mic: Mic,
  "message-circle": MessageCircle,
  "more-vertical": MoreVertical,
  "notebook-pen": NotebookPen,
  paperclip: Paperclip,
  pin: Pin,
  "rotate-ccw": RotateCcw,
  route: Route,
  "scroll-text": ScrollText,
  "send-horizontal": SendHorizontal,
  server: Server,
  settings: Settings,
  square: Square,
  "square-pen": SquarePen,
  star: Star,
  "trash-2": Trash2,
  "triangle-alert": TriangleAlert,
  "wifi-off": WifiOff,
  "maximize-2": Maximize2,
  "minimize-2": Minimize2,
  x: X,
} as const;

export type IconName = keyof typeof iconNodes;

export function isIconName(value: string): value is IconName {
  return Object.prototype.hasOwnProperty.call(iconNodes, value);
}

export function iconElement(name: IconName) {
  return createElement(iconNodes[name], { "aria-hidden": "true" });
}

export function setIcon(element: HTMLElement, name: IconName) {
  element.textContent = "";
  element.append(iconElement(name));
}
