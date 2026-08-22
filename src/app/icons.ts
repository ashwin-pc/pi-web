import { ArrowLeft, Bell, Bookmark, Brain, Check, ChevronRight, Copy, CornerDownRight, createElement, Flag, FolderTree, Funnel, GitBranch, GitFork, Hourglass, Info, KeyRound, Maximize2, Minimize2, Menu, MoreVertical, NotebookPen, Paperclip, Pin, RotateCcw, Route, ScrollText, SendHorizontal, Settings, Square, SquarePen, Star, Trash2, X } from "lucide";

const iconNodes = {
  "arrow-left": ArrowLeft,
  bell: Bell,
  bookmark: Bookmark,
  brain: Brain,
  check: Check,
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
  menu: Menu,
  "more-vertical": MoreVertical,
  "notebook-pen": NotebookPen,
  paperclip: Paperclip,
  pin: Pin,
  "rotate-ccw": RotateCcw,
  route: Route,
  "scroll-text": ScrollText,
  "send-horizontal": SendHorizontal,
  settings: Settings,
  square: Square,
  "square-pen": SquarePen,
  star: Star,
  "trash-2": Trash2,
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

export function setIcon(button: HTMLButtonElement, name: IconName) {
  button.textContent = "";
  button.append(iconElement(name));
}
