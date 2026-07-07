import { Bookmark, Brain, Check, Copy, CornerDownRight, createElement, Flag, Funnel, GitBranch, GitFork, KeyRound, Maximize2, Minimize2, Menu, MoreVertical, Paperclip, Pin, RotateCcw, Route, ScrollText, SendHorizontal, Server, Settings, Square, SquarePen, Star, Trash2, X } from "lucide";

const iconNodes = {
  bookmark: Bookmark,
  brain: Brain,
  check: Check,
  copy: Copy,
  "corner-down-right": CornerDownRight,
  flag: Flag,
  funnel: Funnel,
  "git-branch": GitBranch,
  "git-fork": GitFork,
  "key-round": KeyRound,
  menu: Menu,
  "more-vertical": MoreVertical,
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
  "maximize-2": Maximize2,
  "minimize-2": Minimize2,
  x: X,
} as const;

export type IconName = keyof typeof iconNodes;

export function iconElement(name: IconName) {
  return createElement(iconNodes[name], { "aria-hidden": "true" });
}

export function setIcon(button: HTMLButtonElement, name: IconName) {
  button.textContent = "";
  button.append(iconElement(name));
}
