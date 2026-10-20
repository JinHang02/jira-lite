// The keyboard shortcuts, as shown in the "Keyboard shortcuts" dialog (?). Pure data; keyboard.js
// implements them. Each item: {keys: [combo, ...], label}; a combo is a list of key caps, and
// alternative combos are shown with "or".

/** Shortcut groups; `mac` picks ⌘ vs Ctrl for the modifier. */
export function shortcutGroups(mac = true) {
  const mod = mac ? "⌘" : "Ctrl";
  return [
    { title: "General", items: [
      { keys: [[mod, "K"]], label: "Command menu" },
      { keys: [["C"]], label: "New issue" },
      { keys: [["/"]], label: "Filter issues" },
      { keys: [["R"]], label: "Refresh" },
      { keys: [["?"]], label: "Keyboard shortcuts" },
    ] },
    { title: "Navigation", items: [
      { keys: [["J"], ["↓"]], label: "Next issue" },
      { keys: [["K"], ["↑"]], label: "Previous issue" },
      { keys: [["↵"], ["O"]], label: "Open issue" },
      { keys: [["Esc"]], label: "Close panel or clear filter" },
    ] },
    { title: "Issue", items: [
      { keys: [["S"]], label: "Change status" },
      { keys: [["P"]], label: "Change priority" },
      { keys: [["A"]], label: "Change assignee" },
      { keys: [["M"]], label: "Comment" },
    ] },
    { title: "Views", items: [
      { keys: [[mod, "B"]], label: "Toggle list / board" },
      { keys: [["["]], label: "Toggle sidebar" },
    ] },
  ];
}
