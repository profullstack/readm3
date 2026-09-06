/**
 * `:shortcode:` to emoji, the GitHub spelling.
 *
 * A curated set rather than the full 1,800-entry gemoji table: this is a
 * reader, the long tail is names nobody types, and the whole point of keeping
 * readm3 to two dependencies is not shipping a data file to save a map.
 * An unknown shortcode is left alone, which is also what GitHub does.
 */
export const EMOJI: Readonly<Record<string, string>> = {
  // reactions
  "+1": "👍", "-1": "👎", thumbsup: "👍", thumbsdown: "👎",
  smile: "😄", smiley: "😃", grin: "😁", laughing: "😆", joy: "😂", rofl: "🤣",
  wink: "😉", blush: "😊", heart_eyes: "😍", thinking: "🤔", neutral_face: "😐",
  confused: "😕", cry: "😢", sob: "😭", scream: "😱", angry: "😠", rage: "😡",
  sunglasses: "😎", nerd_face: "🤓", shrug: "🤷", facepalm: "🤦", eyes: "👀",
  wave: "👋", clap: "👏", pray: "🙏", muscle: "💪", ok_hand: "👌", point_right: "👉",
  raised_hands: "🙌", handshake: "🤝", tada: "🎉", confetti_ball: "🎊", partying_face: "🥳",
  heart: "❤️", broken_heart: "💔", sparkling_heart: "💖", orange_heart: "🧡",
  yellow_heart: "💛", green_heart: "💚", blue_heart: "💙", purple_heart: "💜",

  // status and review
  white_check_mark: "✅", heavy_check_mark: "✔️", ballot_box_with_check: "☑️",
  x: "❌", negative_squared_cross_mark: "❎", heavy_multiplication_x: "✖️",
  warning: "⚠️", exclamation: "❗", question: "❓", grey_question: "❔",
  bangbang: "‼️", no_entry: "⛔", no_entry_sign: "🚫", construction: "🚧",
  rotating_light: "🚨", stop_sign: "🛑", checkered_flag: "🏁", triangular_flag_on_post: "🚩",
  bulb: "💡", memo: "📝", pencil2: "✏️", pushpin: "📌", round_pushpin: "📍",
  bookmark: "🔖", label: "🏷️", link: "🔗", paperclip: "📎", scroll: "📜",
  clipboard: "📋", card_index_dividers: "🗂️", file_folder: "📁", open_file_folder: "📂",
  page_facing_up: "📄", books: "📚", book: "📖", closed_book: "📕", green_book: "📗",
  blue_book: "📘", orange_book: "📙", notebook: "📓", ledger: "📒", newspaper: "📰",

  // engineering
  rocket: "🚀", fire: "🔥", boom: "💥", zap: "⚡", star: "⭐", star2: "🌟",
  sparkles: "✨", dizzy: "💫", bug: "🐛", ant: "🐜", beetle: "🪲", spider: "🕷️",
  wrench: "🔧", hammer: "🔨", hammer_and_wrench: "🛠️", nut_and_bolt: "🔩",
  gear: "⚙️", toolbox: "🧰", microscope: "🔬", telescope: "🔭", mag: "🔍",
  mag_right: "🔎", lock: "🔒", unlock: "🔓", closed_lock_with_key: "🔐", key: "🔑",
  shield: "🛡️", package: "📦", gift: "🎁", inbox_tray: "📥", outbox_tray: "📤",
  floppy_disk: "💾", cd: "💿", computer: "💻", desktop_computer: "🖥️",
  keyboard: "⌨️", printer: "🖨️", satellite: "🛰️", electric_plug: "🔌",
  battery: "🔋", bulb_off: "💡", robot: "🤖", alien: "👾", space_invader: "👾",
  test_tube: "🧪", dna: "🧬", petri_dish: "🧫", magnet: "🧲", brain: "🧠",
  hourglass: "⌛", hourglass_flowing_sand: "⏳", stopwatch: "⏱️", alarm_clock: "⏰",
  calendar: "📅", date: "📆", chart_with_upwards_trend: "📈",
  chart_with_downwards_trend: "📉", bar_chart: "📊", abacus: "🧮",

  // arrows and shapes
  arrow_right: "➡️", arrow_left: "⬅️", arrow_up: "⬆️", arrow_down: "⬇️",
  arrows_counterclockwise: "🔄", recycle: "♻️", repeat: "🔁", back: "🔙",
  small_blue_diamond: "🔹", small_orange_diamond: "🔸", large_blue_circle: "🔵",
  red_circle: "🔴", white_circle: "⚪", black_circle: "⚫", green_circle: "🟢",
  yellow_circle: "🟡", orange_circle: "🟠", purple_circle: "🟣", brown_circle: "🟤",

  // odds and ends that show up in READMEs
  coffee: "☕", beer: "🍺", champagne: "🍾", pizza: "🍕", cookie: "🍪", cake: "🍰",
  snowflake: "❄️", sunny: "☀️", cloud: "☁️", rainbow: "🌈", earth_americas: "🌎",
  globe_with_meridians: "🌐", moon: "🌙", crystal_ball: "🔮", trophy: "🏆",
  medal_sports: "🏅", first_place_medal: "🥇", dart: "🎯", game_die: "🎲",
  video_game: "🎮", art: "🎨", performing_arts: "🎭", clapper: "🎬", camera: "📷",
  movie_camera: "🎥", loud_sound: "🔊", mute: "🔇", bell: "🔔", no_bell: "🔕",
  mega: "📣", loudspeaker: "📢", speech_balloon: "💬", thought_balloon: "💭",
  bust_in_silhouette: "👤", busts_in_silhouette: "👥", office: "🏢", house: "🏠",
  penguin: "🐧", whale: "🐳", dolphin: "🐬", octopus: "🐙", snake: "🐍",
  turtle: "🐢", rabbit: "🐰", cat: "🐱", dog: "🐶", unicorn: "🦄", dragon: "🐉",
  seedling: "🌱", herb: "🌿", four_leaf_clover: "🍀", maple_leaf: "🍁",
  tanabata_tree: "🎋", christmas_tree: "🎄", jack_o_lantern: "🎃", ghost: "👻",
  skull: "💀", poop: "💩", salt: "🧂", sos: "🆘", new: "🆕", free: "🆓",
  cool: "🆒", ok: "🆗", up: "🆙", copyright: "©️", registered: "®️", tm: "™️",
  infinity: "♾️", heavy_plus_sign: "➕", heavy_minus_sign: "➖",
  heavy_division_sign: "➗", heavy_equals_sign: "🟰",
};

/** The emoji for a shortcode, or `null` when it is not one we know. */
export function emojiFor(name: string): string | null {
  return Object.hasOwn(EMOJI, name) ? (EMOJI[name] as string) : null;
}
