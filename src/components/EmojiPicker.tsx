/**
 * Emoji picker for page icons and callout icons.
 *
 * Emoji here are the user's content (Notion page icons), so they are correct
 * in this grid — app chrome stays Lucide-only.
 */

import { useEffect, useState } from "react";
import { Search, Smile, SmilePlus } from "lucide-react";

type Category = "Faces" | "Objects" | "Symbols" | "Nature" | "Food" | "Activity" | "Places";

interface Entry {
  emoji: string;
  keywords: string[];
  category: Category;
}

const E: Category = "Faces";
const O: Category = "Objects";
const S: Category = "Symbols";
const N: Category = "Nature";
const F: Category = "Food";
const A: Category = "Activity";
const P: Category = "Places";

/** Curated set — the icons people actually reach for on a page. */
const EMOJI: Entry[] = ([
  ["😀", "grin happy smile", E], ["😃", "happy smile open", E], ["😄", "smile eye", E], ["😁", "grin eye", E],
  ["😆", "laugh haha", E], ["😅", "sweat laugh", E], ["🤣", "rofl rolling", E], ["🙂", "slight", E],
  ["😉", "wink", E], ["😊", "blush smile", E], ["😍", "heart eyes love", E], ["🤩", "star eyes wow", E],
  ["😘", "kiss", E], ["😜", "silly tongue", E], ["🤪", "zany crazy", E], ["🤗", "hugs", E],
  ["🤔", "thinking hmm", E], ["🤐", "zip", E], ["😐", "neutral", E], ["😑", "expressionless", E],
  ["🤨", "raised eyebrow suspicious", E], ["😏", "smirk", E], ["🙄", "eye roll", E], ["😴", "sleep zzz", E],
  ["😌", "relief calm", E], ["😎", "cool sunglasses", E], ["🤓", "nerd glasses", E], ["🧐", "monocle", E],
  ["🤖", "robot bot ai", E], ["😺", "cat smile", E], ["👋", "wave hand hi", E], ["👍", "thumbs up yes ok", E],
  ["👎", "thumbs down no", E], ["👏", "clap applause", E], ["🙌", "raise hands praise", E], ["🤝", "handshake deal", E],
  ["🙏", "pray thanks please", E], ["💪", "muscle strong", E], ["👀", "eyes look watch", E], ["🧠", "brain mind think", E],
  ["❤️", "heart love red", S], ["🧡", "heart orange", S], ["💛", "heart yellow", S], ["💚", "heart green", S],
  ["💙", "heart blue", S], ["💜", "heart purple", S], ["🖤", "heart black", S], ["🤍", "heart white", S],
  ["💔", "heartbreak broken", S], ["💯", "hundred 100 perfect", S], ["✅", "check done todo", S], ["❌", "cross no fail", S],
  ["⚠️", "warning caution", S], ["❓", "question ask", S], ["❗", "exclamation important", S], ["🔥", "fire hot lit", S],
  ["⭐", "star favorite", S], ["🌟", "star glow sparkle", S], ["✨", "sparkles magic new", S], ["💫", "dizzy star", S],
  ["🎯", "target goal bullseye", S], ["🏆", "trophy win award", S], ["🥇", "medal first gold", S], ["🎉", "party celebrate tada", S],
  ["🎊", "confetti", S], ["🔒", "lock secure private", S], ["🔑", "key secret", S], ["🔗", "link chain url", S],
  ["📌", "pin pinned", S], ["📍", "pin location place", S], ["☑️", "checkbox todo", S], ["➡️", "arrow right next", S],
  ["⬅️", "arrow left back", S], ["⬆️", "arrow up", S], ["⬇️", "arrow down", S], ["↩️", "arrow return undo", S],
  ["🚀", "rocket launch ship start", P], ["🛠️", "tools build fix", O], ["⚙️", "gear settings config", O],
  ["🧩", "puzzle piece", O], ["🔧", "wrench fix", O], ["🔨", "hammer build", O], ["⛏️", "pick dig", O],
  ["🧲", "magnet attract", O], ["🔬", "microscope research science", O], ["🔭", "telescope space", O],
  ["💡", "idea bulb light callout", O], ["📚", "books library read", O], ["📖", "book open read", O],
  ["📝", "memo write note", O], ["✏️", "pencil write edit", O], ["📋", "clipboard list", O],
  ["📁", "folder", O], ["📂", "folder open", O], ["🗂️", "dividers index", O], ["📄", "page document file", O],
  ["📑", "bookmark tabs", O], ["🔖", "bookmark save", O], ["📎", "clip attach", O], ["📐", "ruler design", O],
  ["📊", "chart bar data", O], ["📈", "chart up growth", O], ["📉", "chart down decline", O],
  ["🗓️", "calendar date", O], ["📅", "calendar schedule", O], ["⏰", "alarm time clock", O], ["⏱️", "stopwatch timer", O],
  ["💻", "laptop computer dev", O], ["🖥️", "desktop monitor", O], ["📱", "phone mobile", O], ["⌨️", "keyboard type", O],
  ["🖱️", "mouse click", O], ["🔋", "battery power", O], ["💾", "disk save floppy", O], ["🗄️", "cabinet archive db", O],
  ["🌐", "globe web world www", O], ["🔍", "search magnify find", O], ["🔔", "bell notify reminder", O],
  ["🔕", "bell mute off", O], ["🎵", "music note", O], ["🎧", "headphones audio listen", O], ["🎬", "clap action video", O],
  ["📷", "camera photo", O], ["🎥", "camera video movie", O], ["🖼️", "frame image picture", O],
  ["🧪", "test tube lab experiment", O], ["🧗", "climb", A], ["☕", "coffee drink break", F], ["🍵", "tea drink", F],
  ["🍕", "pizza food", F], ["🍎", "apple fruit", F], ["🌶️", "spicy hot pepper", F], ["🍰", "cake celebrate", F],
  ["🌱", "seedling new grow", N], ["🌿", "herb plant", N], ["🍀", "clover luck", N], ["🌲", "tree evergreen", N],
  ["🌳", "tree oak", N], ["🌵", "cactus", N], ["🌍", "earth world globe", N], ["☀️", "sun day bright", N],
  ["🌙", "moon night dark", N], ["⭐", "star night", N], ["☁️", "cloud weather", N], ["⛅", "cloud sun", N],
  ["🌧️", "rain weather", N], ["❄️", "snow cold winter", N], ["🌈", "rainbow", N], ["🌊", "wave water", N],
  ["🐛", "bug insect defect", N], ["🐝", "bee", N], ["🦋", "butterfly", N], ["🐢", "turtle slow", N],
  ["🦊", "fox", N], ["🐺", "wolf", N], ["🦉", "owl wise", N], ["🐴", "horse", N], ["🦄", "unicorn", N],
  ["🐱", "cat", N], ["🐶", "dog", N], ["🐧", "penguin", N], ["🐙", "octopus", N],
  ["🏃", "run sprint", A], ["🚴", "bike cycle", A], ["🏊", "swim", A], ["🧘", "meditate yoga", A],
  ["⚽", "soccer football", A], ["🏀", "basketball", A], ["🎮", "game play controller", A], ["🎲", "dice random", A],
  ["♟️", "chess strategy", A], ["🏁", "flag finish", A], ["🚩", "flag marker red", A],
  ["🏠", "home house", P], ["🏢", "office building", P], ["🏗️", "construction build wip", P], ["🌍", "world intl", P],
  ["🚗", "car drive", P], ["✈️", "plane travel flight", P], ["🚢", "ship boat", P], ["🛫", "departure", P],
  ["🎓", "graduate school learn", P], ["💼", "briefcase work", P], ["🏦", "bank finance", P], ["💰", "money", P],
  ["💵", "cash dollar", P], ["📦", "box package ship", P], ["🛒", "cart shop buy", P], ["🎁", "gift present", P],
  ["👤", "person user", P], ["👥", "people team", P], ["🕵️", "investigate debug", P], ["🧑‍💻", "developer coder", P],
] as [string, string, Category][]).map(([emoji, keywords, category]) => ({
  emoji,
  keywords: keywords.split(" "),
  category,
}));

const CATEGORIES: Category[] = ["Faces", "Objects", "Symbols", "Nature", "Food", "Activity", "Places"];

export interface EmojiPickerProps {
  onPick: (emoji: string) => void;
  onClose: () => void;
}

export function EmojiPicker(props: EmojiPickerProps): React.ReactNode {
  const [mounted, setMounted] = useState(false);
  const [visible, setVisible] = useState(false);
  const [query, setQuery] = useState("");
  const [category, setCategory] = useState<Category>("Faces");

  useEffect(() => {
    setMounted(true);
    requestAnimationFrame(() => requestAnimationFrame(() => setVisible(true)));
  }, []);

  const close = (): void => {
    setVisible(false);
    window.setTimeout(props.onClose, 260);
  };

  const q = query.trim().toLowerCase();
  const list = q
    ? EMOJI.filter((e) => e.keywords.some((k) => k.includes(q)) || e.emoji === query.trim())
    : EMOJI.filter((e) => e.category === category);

  return (
    <div
      className={`sn-overlay ${visible ? "is-open" : ""}`}
      onMouseDown={close}
      role="dialog"
      aria-label="Choose an icon"
    >
      <div className="sn-overlay-panel" onMouseDown={(e) => e.stopPropagation()} style={{ width: "min(560px, 92vw)" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, borderBottom: "1px solid var(--border-subtle)" }}>
          <SmilePlus size={16} strokeWidth={1.5} />
          <span style={{ fontWeight: 600 }}>Page icon</span>
          <div style={{ flex: 1 }} />
          <div style={{ position: "relative", width: 220 }}>
            <Search size={12} strokeWidth={1.5} style={{ position: "absolute", left: 6, top: 6, opacity: 0.5 }} />
            <input
              className="sn-input"
              style={{ paddingLeft: 22 }}
              placeholder="Search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoFocus
            />
          </div>
        </div>

        {!q && (
          <div style={{ display: "flex", gap: 4, padding: "8px 10px", flexWrap: "wrap", borderBottom: "1px solid var(--border-subtle)" }}>
            {CATEGORIES.map((c) => (
              <button
                key={c}
                className="sn-pill"
                style={{
                  background: c === category ? "var(--accent-highlight-muted)" : undefined,
                  borderColor: c === category ? "var(--accent-highlight)" : undefined,
                }}
                onClick={() => setCategory(c)}
              >
                {c}
              </button>
            ))}
          </div>
        )}

        <div style={{ maxHeight: 340, overflowY: "auto", padding: 8, display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(40px, 1fr))", gap: 2 }}>
          {list.map((e) => (
            <button
              key={e.emoji + e.keywords[0]}
              title={e.keywords.slice(0, 3).join(", ")}
              onClick={() => {
                props.onPick(e.emoji);
                close();
              }}
              style={{
                height: 36,
                fontSize: 20,
                background: "transparent",
                border: 0,
                borderRadius: "var(--radius-md)",
                cursor: "pointer",
                transition: "background-color 120ms ease",
              }}
              onMouseEnter={(ev) => (ev.currentTarget.style.background = "var(--bg-hover)")}
              onMouseLeave={(ev) => (ev.currentTarget.style.background = "transparent")}
            >
              {e.emoji}
            </button>
          ))}
          {list.length === 0 && (
            <div className="sn-empty" style={{ gridColumn: "1 / -1" }}>
              <Smile size={24} strokeWidth={1.5} style={{ opacity: 0.4 }} />
              <div style={{ marginTop: 8 }}>No icon matches “{query}”</div>
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, padding: 10, borderTop: "1px solid var(--border-subtle)" }}>
          <button
            className="sn-btn sn-btn-destructive sn-btn-sm"
            onClick={() => {
              props.onPick("");
              close();
            }}
          >
            Remove icon
          </button>
          <span style={{ flex: 1 }} />
          <span className="sn-eyebrow">{list.length} icons</span>
          <button className="sn-btn sn-btn-sm" onClick={close}>
            Close
          </button>
        </div>
      </div>
    </div>
  );
}
