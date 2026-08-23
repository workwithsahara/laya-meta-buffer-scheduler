#!/usr/bin/env node
/**
 * LAYA -> Buffer (Meta account) daily queue top-up (THREE TRACKS, PER CHANNEL)
 * -----------------------------------------------------------------------
 * Standalone twin of the LinkedIn+TikTok LAYA automation, pointed at a
 * SEPARATE Buffer account/login used only for Facebook + Instagram +
 * Threads (Buffer's free plan caps at 3 channels per account, so LAYA
 * uses two separate Buffer logins). Independent repo on purpose -- nothing
 * here can affect the other LAYA automation or vice versa.
 *
 * Manages THREE independent content tracks on EACH channel, sharing each
 * channel's ONE Buffer queue:
 *
 *   MAIN track:      the original dated LAYA content -- one post per real
 *                     calendar day, at POST_TIME_LOCAL, sourced from
 *                     LAYA_ROOT_FOLDER_ID/<year>/<month>/DD_<mon><DD>_<slug>.png.
 *   PROMO track:      the "365 LAYA System" promotional series -- a flat,
 *                     sequentially-numbered library (Day001.png .. Day365.png)
 *                     under PROMO_ROOT_FOLDER_ID, posted every
 *                     PROMO_INTERVAL_HOURS (default 4h) with a single fixed
 *                     caption (PROMO_CAPTION) on every post.
 *   COACHING track:   the "high-functioning woman" 1:1 coaching campaign --
 *                     a flat, sequentially-numbered library (day_001.png ..
 *                     day_365.png) under COACHING_ROOT_FOLDER_ID, posted every
 *                     COACHING_INTERVAL_HOURS (default 8h). Each image gets
 *                     its OWN caption (from the embedded COACHING_CAPTIONS
 *                     list below, same order as the day_NNN.png files) plus
 *                     the fixed COACHING_CTA appended. Cycles forever once
 *                     day 365 is reached, same as PROMO/evergreen libraries.
 *
 * Buffer caps the TOTAL number of scheduled (not-yet-sent) posts per
 * CHANNEL -- it doesn't know about "tracks". This script manages all three
 * together per channel: reads the current queue ONCE, classifies each
 * existing post into MAIN / PROMO / COACHING, then interleaves new posts
 * from all three tracks in true chronological order until that channel's
 * share of the limit is reached.
 *
 * Classification of an existing scheduled post:
 *   - text === PROMO_CAPTION                    -> PROMO
 *   - text contains COACHING_CTA_MARKER          -> COACHING
 *   - anything else                              -> MAIN
 *
 * Required environment variables (set as repo/CI secrets):
 *   BUFFER_API_KEY          Personal API key from this Buffer account's Settings > API
 *   BUFFER_ORG_ID            This Buffer account's organization ID
 *   BUFFER_CHANNEL_IDS       Comma-separated channel IDs (Facebook, Instagram, Threads)
 *   GOOGLE_DRIVE_API_KEY     API key with Drive API enabled (read-only is fine)
 *   LAYA_ROOT_FOLDER_ID      Drive folder ID of the MAIN "LAYA" content root
 *   PROMO_ROOT_FOLDER_ID     Drive folder ID of the PROMO content root
 *                            (containing Day001.png .. Day365.png)
 *   PROMO_CAPTION            Fixed caption text used on every PROMO post
 *   COACHING_ROOT_FOLDER_ID  Drive folder ID of the COACHING content root
 *                            (containing day_001.png .. day_365.png)
 * Optional:
 *   BUFFER_MIN_DATE             Default skip-before date (YYYY-MM-DD) for MAIN,
 *                                applied to any channel without its own override.
 *   BUFFER_CHANNEL_MIN_DATES    Per-channel MAIN overrides, comma-separated
 *                                "channelId=YYYY-MM-DD" pairs (empty date =
 *                                no minimum for that channel).
 *   POST_TIME_LOCAL          Default "19:00:00" (7 PM) -- MAIN track only
 *   POST_UTC_OFFSET          Default "+08:00" (Asia/Manila)
 *   PROMO_INTERVAL_HOURS     Default 4
 *   COACHING_INTERVAL_HOURS  Default 8
 *   DRY_RUN                  "true" to log without creating posts
 *
 * Requires Node.js 18+ (uses global fetch).
 */

const BUFFER_API_KEY = requireEnv("BUFFER_API_KEY");
const ORG_ID = requireEnv("BUFFER_ORG_ID");
const CHANNEL_IDS = requireEnv("BUFFER_CHANNEL_IDS").split(",").map((s) => s.trim());
const DRIVE_API_KEY = requireEnv("GOOGLE_DRIVE_API_KEY");
const ROOT_FOLDER_ID = requireEnv("LAYA_ROOT_FOLDER_ID");
const PROMO_ROOT_FOLDER_ID = requireEnv("PROMO_ROOT_FOLDER_ID");
const PROMO_CAPTION = requireEnv("PROMO_CAPTION");
const COACHING_ROOT_FOLDER_ID = requireEnv("COACHING_ROOT_FOLDER_ID");

const DEFAULT_MIN_DATE = process.env.BUFFER_MIN_DATE || null;

function parseChannelMinDates(raw) {
  const map = {};
  if (!raw) return map;
  for (const pair of raw.split(",")) {
    const [channelId, date] = pair.split("=").map((s) => (s || "").trim());
    if (!channelId) continue;
    map[channelId] = date || null;
  }
  return map;
}
const CHANNEL_MIN_DATES = parseChannelMinDates(process.env.BUFFER_CHANNEL_MIN_DATES);
function minDateFor(channelId) {
  return channelId in CHANNEL_MIN_DATES ? CHANNEL_MIN_DATES[channelId] : DEFAULT_MIN_DATE;
}

const POST_TIME_LOCAL = process.env.POST_TIME_LOCAL || "19:00:00"; // 7 PM
const POST_UTC_OFFSET = process.env.POST_UTC_OFFSET || "+08:00"; // Asia/Manila
const PROMO_INTERVAL_HOURS = parseInt(process.env.PROMO_INTERVAL_HOURS || "4", 10);
const COACHING_INTERVAL_HOURS = parseInt(process.env.COACHING_INTERVAL_HOURS || "8", 10);
const DRY_RUN = process.env.DRY_RUN === "true";

// Fixed anchors so PROMO/COACHING image selection is stateless and
// deterministic across runs. Never change these once each track is live.
const PROMO_EPOCH_START = new Date("2026-08-05T00:00:00Z");
const COACHING_EPOCH_START = new Date("2026-08-23T00:00:00Z");
const LEAD_BUFFER_MS = 5 * 60 * 1000; // 5-minute lead so dueAt is always in the future

// Fixed CTA appended to every COACHING post's caption. Also doubles as the
// classification marker (a scheduled post is COACHING if its text contains
// this substring).
const COACHING_CTA_MARKER = 'DM "I want to be soft too"';
const COACHING_CTA = '\ud83c\udf3f Ready to hold it differently? DM "I want to be soft too" and let\'s talk about the 1:1 coaching space.';

// Per-image captions for the COACHING track, in the same order as
// day_001.png .. day_365.png sorted naturally. Index 0 = day_001.png.

const COACHING_CAPTIONS = [
  "She's the one everyone calls when things fall apart. But no one ever stops to ask if SHE'S okay.",
  "She smiled through the whole dinner. No one asked what was underneath it.",
  "She's in the room. But some days, she's not really there.",
  "She became the strong one before she was ever asked if she wanted to be.",
  "She pours into everyone. No one checks what's left for her.",
  "She's never been given permission to rest. So she never learned how.",
  "She holds the household up financially. No one wonders if she's struggling too.",
  "She's everyone's safe place to land. She never built one for herself.",
  "She makes it look easy. Easy and light are not the same thing.",
  "She's tired of being \"the strong one.\" She just wants to be soft sometimes.",
  "She answers at 11pm. Every time. Without thinking twice.",
  "She's never said \"I can't handle this\" out loud. Not once.",
  "Capable and fine are not the same thing. No one's checked the difference.",
  "She's always scanning the room. Someone has to.",
  "She remembers everyone. Rarely gets remembered the same way back.",
  "She cried in the car. Then walked in like nothing happened.",
  "She gives the advice she's never once taken herself.",
  "From the outside, it's working. No one sees what it costs.",
  "She's everyone's emergency contact. Who's hers?",
  "She apologizes for needing help more than she asks for it.",
  "She knows how to show up for everyone. No one showed her how to let them show up for her.",
  "Being \"fine\" isn't a lie. It's just easier than explaining.",
  "She holds space for everyone. No one asks if there's any left for her.",
  "Some mornings she's already tired. She gets up anyway.",
  "Her voice stays steady. Even when everything else isn't.",
  "Pride and exhaustion live in the same place. People only see the pride.",
  "There's never a convenient time to fall apart. So she doesn't.",
  "She's the reason things run smoothly. No one sees what that takes.",
  "She'll rest \"after this next thing.\" There's always a next thing.",
  "She holds everyone's hard days. Where does she put her own?",
  "Strong and struggling were never supposed to cancel each other out.",
  "She has a face for other people. It's not fake. It's just not the whole truth.",
  "\"Good, busy!\" The real answer would've taken longer than she had.",
  "She always turns the question back around. It's second nature by now.",
  "The laugh comes a beat too loud. Just enough to fill the space.",
  "She walks in ready with a plan. No one saw the drive over here.",
  "She shares just enough to seem open. Never enough to actually be open.",
  "\"You always seem so put together.\" She's stopped knowing if that's a compliment.",
  "There's a version of her for everyone. None of them get the whole picture.",
  "She answers \"how are you\" before they finish asking. It buys her time.",
  "Between managing everyone's expectations, she lost track of her own.",
  "She's been the calm one for so long, even she forgot it's optional.",
  "She rehearses the edited version in the shower. The truth takes too long to explain.",
  "Even her grief learned to stay quiet. Doors locked, water running.",
  "It's working, mostly. It's just not the whole story.",
  "She can disappear in a crowded room without leaving her seat.",
  "\"You have it all figured out.\" She let them believe it. Easier that way.",
  "Small talk is her shield. It keeps things from getting close.",
  "She always shows up on time. What it costs to get here is invisible.",
  "She nods along. Her mind is running through everything she's not saying.",
  "\"It's been a lot lately.\" Vague on purpose. Vague doesn't invite questions.",
  "She comforts people the way she wishes someone would comfort her.",
  "\"I'm okay\" isn't a lie or the truth anymore. It's just the thing she says.",
  "She gave real advice while quietly falling apart. No one on the other end knew.",
  "Her breakdowns are timed for when no one's around. The bathroom. The car. Late at night.",
  "She keeps her phone face down, like someone could catch the thought mid-sentence.",
  "Exhaustion dressed up as busyness. Busy is easier for people to hold.",
  "\"I'm fine, just tired.\" A door closing before anyone gets close.",
  "She's allowed to stop performing okay. The mask was never required.",
  "She read the room before she learned long division.",
  "No one told her to grow up fast. There just wasn't another option.",
  "\"So mature for her age.\" Really just a kid learning not to need anything.",
  "She learned young that her job was to make it easier. No one ever released her from it.",
  "She kept the peace between adults. Somewhere she stopped being a kid.",
  "She comforted the parent who should have comforted her. She's still doing versions of that.",
  "No one asked if she wanted the role. It was decided before she could object.",
  "She learned to stay quiet about her needs before she learned to ride a bike.",
  "Babysitter, translator, tech support, emotional support. All before she was a teenager.",
  "Love looked like being needed. So she made herself endlessly needed.",
  "The kid who never caused problems. Still managing everyone's comfort before her own.",
  "She realized the adults needed her more than she needed them. Far too young.",
  "She skipped being taken care of. Went straight to taking care of.",
  "She learned to soothe herself alone. Got good at it. Maybe too good.",
  "She held it together at home. It quietly became her whole personality.",
  "Responsible for adult emotions before she had words for her own.",
  "The family's unofficial fixer, before she could legally drive. No end date was ever given.",
  "It started as survival. Somewhere along the way, people called it her personality.",
  "\"Never a burden.\" That quietly taught her that needing things made her one.",
  "The eldest. The responsible one. She still carries that exact weight.",
  "She managed a household's mood before she understood her own.",
  "She was the calm in someone else's storm. No one was ever the calm in hers.",
  "She learned asking for help made adults uncomfortable. That lesson never left.",
  "A child doing adult emotional labor. Translating, explaining, making the calls.",
  "Her worth got tied to usefulness early. It's still running in the background.",
  "She learned to be easy so she wouldn't add to the load. She still is.",
  "She never learned how to be comforted. Only how to comfort.",
  "In her house, feelings got managed quickly. She still manages hers that way.",
  "She kept score of everyone's needs. No one kept score of hers.",
  "Resilience she never chose to build. People call it a strength. She remembers the cost.",
  "The little girl who grew up too fast is allowed to be soft now. The emergency is over.",
  "Everyone else gets her best hours. Her family gets what's left.",
  "She says yes with an empty tank. Her own limits never factor in.",
  "She checks on ten people a day. Forgets to check on herself, every time.",
  "She's given burnout advice while quietly burning out herself.",
  "There's a running list for everyone else. No real list for her own needs.",
  "Self-care happens in the leftover minutes. Whatever's not already claimed.",
  "Endless patience for everyone else. None saved for herself.",
  "Running on empty started to feel normal. She forgot what full feels like.",
  "She keeps giving on empty. Stopping was never taught as an option.",
  "She spots a friend's burnout in one sentence. Misses her own for months.",
  "By the time it's her turn, she's usually too tired to say the real thing.",
  "Running on fumes works, technically. It's just not sustainable.",
  "She shows up fully, especially on the days she has nothing left.",
  "Giving from empty became normal. Filling the cup first got skipped.",
  "She remembers everyone else's needs. No one's tracking hers.",
  "Grace for everyone else's bad days. None for her own.",
  "She apologizes for being tired, like it's an inconvenience she's causing.",
  "Pieces of her time went to everyone who asked. None were left for her.",
  "She smiles through depletion so well, no one knows she's running low.",
  "Strangers get her patience. The people closest to her get what's left.",
  "The giving doesn't pause for weekends, vacations, or sick days. No off switch in sight.",
  "She keeps pouring into relationships that don't pour back. It was never supposed to be that way.",
  "Rest feels unfamiliar now. Like a language she used to speak.",
  "The cup ran dry weeks ago. She's still pouring, because everyone still expects it.",
  "Even with nothing urgent, rest feels like it needs to be earned.",
  "Calm, patience, steady hands, for everyone. No one asks what it costs her.",
  "Receiving care feels wrong now. She's only ever known how to give it.",
  "She hoped giving would get lighter. It just got more familiar.",
  "The cup's been empty longer than she's admitted. Filling it isn't selfish.",
  "Their relief fills her cup for a moment. It's not the same as her own cup being full.",
  "She never rests without a reason ready. Rest still needs a justification.",
  "Even when everything's fine, resting feels wrong. Fine was never enough permission.",
  "She only relaxes once everyone else is handled. Most days, that never happens.",
  "Turning down rest stopped feeling like a choice. It was never who she is.",
  "She tells everyone else to slow down. Never takes the advice herself.",
  "Rest makes her anxious. Like stopping means something will fall apart.",
  "\"I'll rest soon.\" Soon keeps moving further away.",
  "Stillness fills instantly with the next task. It feels almost unsafe.",
  "She rests for her kids without hesitation. Never for herself.",
  "Her exhaustion gets treated like a headache. It's rarely that small.",
  "She's earned rest a hundred times over. She's still waiting for permission that was always hers.",
  "An afternoon of nothing feels almost dangerous. Doing nothing became unsafe somewhere.",
  "Accomplishments count. Rest never did, not in her head.",
  "Half-alert, even in rest, always ready for the next thing that needs her.",
  "Rest, once everything's handled. Everything is never finally handled.",
  "She knows collapsing better than resting. Rest usually comes too late.",
  "Guilt shows up the second she tries to relax. Like an alarm.",
  "Permission for everything except stillness. That one still has to be earned.",
  "Rest disguised as productivity feels safe. Actual stillness feels too exposed.",
  "Waiting for a slow season that never comes. There's always a reason it's not this week.",
  "Her body's been asking for rest for a while. She's been answering with coffee.",
  "Rest as a reward for exhaustion, instead of a right she already has.",
  "A whole day for a friend's move, no hesitation. An hour for herself takes weeks.",
  "She knows rest isn't lazy. Somewhere it hasn't landed yet.",
  "Rest only shows up after burnout forces it. Never as a choice made early.",
  "She rests when told to. Rarely when she quietly asks herself.",
  "Doing less feels like failing. Even when it's exactly what's needed.",
  "Rest and giving up feel the same to her. They were never the same thing.",
  "She only exhales once she's alone. Rest became something to hide.",
  "Rest doesn't require a breakdown first. It's allowed on an ordinary Tuesday.",
  "She's allowed to stop today. Being a person is the only requirement.",
  "The account balance runs in the back of her mind constantly.",
  "\"I've got it\" stopped being generous. It became the assumption.",
  "Everyone's stability depends on her income never dipping.",
  "Career choices made for the family's needs. The trade goes unnoticed by everyone but her.",
  "A permanent mental spreadsheet came with being the capable one.",
  "She's never said no financially. Saying no felt like breaking an unspoken agreement.",
  "The bank balance isn't the whole cost of what she's built.",
  "She's the reason no one else has to worry. Someone has to.",
  "Being the provider quietly pushed her own wants to the bottom of the list.",
  "She carries the weight like it's just who she is. No one thanks her for choosing it.",
  "\"Fine\" always feels one emergency away from not fine.",
  "Giving comes before spending on herself. That order never flips.",
  "She built the safety net for everyone else. No one asked who builds hers.",
  "Needed for her paycheck and for herself, tangled together until she can't tell them apart.",
  "She covers people and never mentions it again. Bringing it up felt like keeping score.",
  "The quiet math never stops running: rent, groceries, the emergency that hasn't happened yet.",
  "She feels responsible for outcomes that were never fully hers to control.",
  "She extends financial trust freely. It's rarely extended back.",
  "Financial security, visible from the outside. The internal cost never makes the picture.",
  "Financially responsible for people who don't see what it requires of her.",
  "\"Good with money\" became a role she can't step out of, even for a day.",
  "She carries the pressure quietly. No one asks, so it never gets mentioned.",
  "Quiet sacrifices, the kind that never come with a thank you.",
  "Someone's whole financial plan, a role she never remembers being asked to take.",
  "She calculates every risk carefully. There's no net catching her mistakes.",
  "The quiet transfers, the covered bills, the help nobody clocked as help.",
  "\"Breadwinner\" stopped feeling like an achievement. It became a permanent condition.",
  "Capable doesn't mean unafraid. She's tired too, more often than anyone knows.",
  "She built the safety net for everyone else. She's allowed to want one of her own.",
  "Provider and provided-for aren't opposites. She's allowed to be both.",
  "Present in body. Gone everywhere else. It happens more than she'd admit.",
  "She arrives without remembering the drive. Autopilot runs more than she'd like.",
  "Laughing and feeling far away, happening at the exact same time.",
  "The same paragraph, five times. Her mind checked out somewhere in between.",
  "Conversations happening on the other side of glass. Close, but not quite there.",
  "Nodding on instinct. Her mind was somewhere else the whole time.",
  "Some days feel like watching her own life instead of living it.",
  "Whole routines happen and disappear from memory almost immediately.",
  "Her body keeps moving. Her mind clocked out hours ago.",
  "A passenger in her own decisions, watching herself agree without feeling it.",
  "Emotions arriving muffled, like they're behind glass. Not numbness. Distance.",
  "Hugging back without quite landing in the moment. Present, but not fully.",
  "Days blur together. Time moves strangely when the tank's been empty this long.",
  "She forgot she's allowed to feel things fully, not just manage them.",
  "Losing the thread mid-sentence. It happens more when she's stretched thin.",
  "The tasks get done. The feeling of the day gets lost somewhere.",
  "Steering her own body from somewhere slightly outside. Hands on the wheel, not quite present.",
  "Surrounded by love, still behind a wall. No one's quite reaching through.",
  "Running on script. The right words, while her attention is somewhere else entirely.",
  "Big moments passing flat, watched from a few feet away instead of felt.",
  "The task is done. She has no memory of doing it. Just the proof.",
  "Checking out became a place her mind learned to go for safety, long ago.",
  "The tears arrive. The reason takes a moment longer to catch up.",
  "Fully engaged on the outside. Somewhere else entirely on the inside.",
  "The gap between knowing she should feel something and actually feeling it. Wider than she'd admit.",
  "A fog she can't fully name. Present enough to function, distant enough that nothing lands.",
  "Reaching for this morning's memory. Coming up mostly empty.",
  "Checking out isn't apathy. It's a nervous system that learned to leave for safety.",
  "Coming back into her body after a long stretch away, without quite remembering the trip.",
  "The distance kept her safe for a long time. It's allowed to soften now.",
  "Checking out was never broken. It was protection. Coming back gets easier with support.",
  "A full-time job nobody sees. Nobody ever hired her for it.",
  "The noticing never turns off. That alone is exhausting.",
  "She adjusts to every room's temperature before anyone else senses the tension.",
  "It looks effortless because she made it look that way. No one sees the work underneath.",
  "A constant background process, tracking everyone's needs. Never acknowledged.",
  "She notices the upset before the words come. Manages it before they process it themselves.",
  "The appointments, the forms, the follow-ups. Quiet work that held everything together.",
  "An unpaid, unnoticed list of who needs checking on. It never stops running.",
  "She remembers the hard dates so no one else has to carry them alone.",
  "She smooths the path before conflict even starts. Prevention no one sees.",
  "Peacekeeping never makes a list. It's some of the heaviest work she does.",
  "Other people's stress becomes hers to solve, even when it was never her responsibility.",
  "She's the family's institutional memory. No one else bothered to track it.",
  "Cleaning up messes that weren't hers to make. Quietly, every time.",
  "The mental load doesn't clock out. It follows her even into her own moments.",
  "Noticing what's wrong before it's said out loud. Vigilance that never rests.",
  "Mediating, translating, softening. No one asks what it costs her.",
  "No one thanks her for the disaster that didn't happen, because she handled it early.",
  "She absorbs the impact so it doesn't land on anyone else.",
  "The quiet upkeep of every relationship. It's rarely reciprocated the same way.",
  "Translating, softening, mediating between people. So constant she stopped noticing.",
  "Unspoken expectations, understood without a word. She just always knew.",
  "She's the one who follows up. Everyone else moves on.",
  "Reliability, assumed like electricity. Rarely questioned, rarely appreciated.",
  "Managing expectations takes more energy some days than the actual work.",
  "Years went into that steadiness. No one asks what it cost to build.",
  "She holds the full picture. No one else gathered the pieces.",
  "An invisible dashboard of everyone's wellbeing. Only she maintains it.",
  "Invisible labor, by design. That's exactly why it's never named.",
  "The weight is real, even when it stays invisible to everyone else.",
  "She's allowed to name the invisible labor. It was always real, named or not.",
  "Compliments about her strength. What she wants is someone to notice the struggle.",
  "She wants someone to ask and actually wait for the real answer.",
  "Tired of translating exhaustion into something easy to hear. She just wants to say it plainly.",
  "She wants a soft place too, not just to be one.",
  "Always holding, never held. She wants that to flip, even briefly.",
  "An ordinary mess, without it becoming an event everyone has to manage.",
  "She's tired of being the calm one. She wants someone to be that for her.",
  "Just tired, honestly. Not dressed up as something admirable.",
  "\"I don't know how you do it all.\" She needed \"let me help\" instead.",
  "The ease is visible. The effort behind it rarely is.",
  "The strong friend, the strong daughter, the strong everything. Some days she just wants to be a person.",
  "Crying, allowed to just exist, without an apology attached.",
  "She's tired of always checking in first. She wants someone to remember without being reminded.",
  "\"I'm not okay,\" allowed to just be the whole sentence.",
  "People need her steady before they'll feel anything. She wants to go first sometimes.",
  "Help, offered without her having to ask, explain, or manage the asking.",
  "Not a rock. A person, with needs of her own.",
  "Rest without guilt. Softness without apology. Ease that doesn't have to be earned.",
  "A place to put down her own hard days, without managing the reaction.",
  "What she needs, asked before what she can give. Just once, in that order.",
  "Okay because she exists, not because of how much she can handle.",
  "The exhaustion in her voice, noticed before she has to name it herself.",
  "Everyone else gets bad days. She's always been the exception.",
  "Softness without strings. Care that doesn't ask for anything back.",
  "Praised for handling it alone. She'd rather be asked if she needs help.",
  "Taken care of, not out of pity. Just ordinary care, for once.",
  "Her needs shouldn't feel like an inconvenience. They're allowed to be ordinary.",
  "Ordinary softness. Not a crisis, not an intervention. Just the regular kind.",
  "Strength as a choice, not the only setting she's allowed.",
  "Wanting softness doesn't undo what she's built. It just means she's ready for company.",
  "Everyone asks for her advice. No one asks if she needs any.",
  "She's asked to fix everything. Rarely asked what's broken in her own life.",
  "Asked to show up for everything. Never asked what it costs her to keep doing it.",
  "She's asked how to handle their hard days. No one asks about her own.",
  "Space held for everyone else's feelings. Rarely asked who holds hers.",
  "Check-ins about their problems, constant. Genuine ones about her, rare enough to remember by name.",
  "Reassurance flows one way, out from her. Rarely back in.",
  "Asked what they should do. Rarely asked what she needs done for her.",
  "Dependable everywhere. No one's asked if that's exhausting her.",
  "Asked for the plan, the next step. Never asked about her own care plan.",
  "Asked to keep it together for others. No one asks what it leaves behind for her.",
  "People come to her struggling. No one notices when she goes quiet.",
  "Feedback given constantly. Rarely received about how she's actually doing.",
  "Asked to remember for everyone else. No one asks if there's room left for her own.",
  "Always the reasonable one. No one asks what that costs when she's the one hurting.",
  "Comfort, given freely. Rarely asked what comfort would look like for her.",
  "She explains everyone else more than she's ever asked to explain herself.",
  "Asked what's wrong with them. Never really asked what's wrong with her.",
  "First call in the crisis. Rarely checked on once it's over.",
  "Asked about their relationships. Rarely asked about the real state of hers.",
  "Everyone's wins get celebrated loudly. Hers pass by quietly.",
  "Patience, asked for during their hard seasons. No one's asked about hers.",
  "Calm, manufactured for other people's chaos. The real cost stays unasked.",
  "Trusted with everyone's secrets. Rarely trusted enough to be asked her own.",
  "Asked how to move forward. Never asked if she's had space to grieve.",
  "Her time, assumed available. Rarely asked what she'd choose to do with it.",
  "Understanding, asked for every time. No one counts how many times it's added up.",
  "She's the exception for everyone else. No one's offered her one back.",
  "Grace, given out constantly. Rarely checked whether any's left for her.",
  "The questions went one way for years. She's allowed to ask them back now.",
  "She's allowed to be asked, for once. She just has to let someone close enough.",
  "\"Yes\" when she meant \"no.\" Still feels safer than risking the relationship.",
  "Guilt shows up the moment she considers herself first.",
  "Her stomach drops before the boundary's even finished being said.",
  "Apologizing for a boundary before it's even finished being spoken.",
  "\"It's fine,\" said about things that weren't. Conflict felt too expensive.",
  "Reasonable boundaries. Still feels responsible for the disappointment that follows.",
  "Rehearsed for days. Softened in the moment, because guilt arrives faster than courage.",
  "The same line, crossed again. Absorbing it felt easier than addressing it.",
  "Wanting space from people she loves. Somehow that feels like a character flaw.",
  "Extra chances given, mostly because disappointing them feels worse than being let down herself.",
  "Dreaded plans, attended anyway. Canceling felt like proof of unreliability.",
  "Resting while someone struggles feels wrong, like her needs have to wait their turn.",
  "Boundaries explained in exhaustive detail, like a limit needs a defense first.",
  "Staying past her capacity, because leaving felt ruder than the cost of staying.",
  "Guilt arrives first. Relief has to fight its way in after.",
  "\"I don't want to be a bother\" said more often than the actual need itself.",
  "Overriding herself became the default, again and again, until it stopped feeling like a choice.",
  "\"I don't want to\" is reason enough for everyone else. Not for her, apparently.",
  "Bracing for anger that's never actually come, every single time.",
  "More patience given to the person who crossed the line than credit given to herself for noticing.",
  "The guilt shows up just from thinking about giving less.",
  "Keeping the peace, at a cost she's not sure she'll fully recover.",
  "\"Yes,\" said to avoid discomfort. Carried like a weight for weeks after.",
  "A boundary that comes with an explanation, an apology, and reassurance, all at once.",
  "Assuming the worst reaction, even from people who've never given her a reason to.",
  "\"No\" watered down to \"maybe,\" until people started hearing it as a soft yes.",
  "Guilt over small choices, a nap, a quiet night, a message that could easily wait.",
  "Guilt gets loudest exactly when she's finally choosing herself.",
  "A boundary was never a betrayal. The people who love her can handle her \"no.\"",
  "Disappointing someone isn't the same as harming them. The guilt just makes it feel that way.",
  "This year carried more than most people saw. It was real. It mattered.",
  "Proud of what she built. Honest about what it cost. Both true at once.",
  "A whole year as everyone's steady place. She's allowed to ask for one of her own.",
  "Held quietly, all year. No recognition needed. She already knows it was heavy.",
  "Grief for the hard parts. Gratitude for the rest. Both belong in the same year.",
  "A year that asked a lot. Making it through deserves real acknowledgment.",
  "Wanting next year to feel lighter isn't ungrateful. It's just honest.",
  "A year spent holding everyone. Next year, she's allowed to be held a little too.",
  "Carried without complaint, all year. Strength most people never even noticed.",
  "New terms for next year. Less sacrifice, more room for herself.",
  "Invisible work all year, off every list. It still counted.",
  "Some of what she's carried, allowed to finally rest as the year ends.",
  "A year of showing up for everyone. Next year, she wants that returned.",
  "Tested in ways that didn't always show. No proof needed, except to herself.",
  "An easier season, earned. Not from weakness, from strength that's gone unrested.",
  "The anchor role came at a real cost. She's finally ready to name it.",
  "Space held for everyone's growth this year. Next year, room for her own.",
  "The hard parts get to just be hard, before they have to become a lesson.",
  "Family, work, and healing, all carried at once this year. Worth sitting with, not minimizing.",
  "Next year, she wants softness that doesn't have to be fought for.",
  "Quiet, unglamorous work all year. It deserves real acknowledgment, even from just herself.",
  "Tired and proud, at the same time. They were never opposites.",
  "Needed by everyone all year. Next year, she's allowed to need someone too.",
  "Rest doesn't have to be earned through exhaustion. That belief is allowed to end here.",
  "Growth that was hard to see while living it. Clearer now, looking back.",
  "A quieter strength, next year. One that doesn't need constant proving.",
  "The anchor all year. Even anchors are allowed to be held.",
  "A year of giving more than most will ever understand. Let that be known, even just to herself.",
  "A new year, chosen differently. Softer boundaries. More rest. More of herself at the center.",
  "The anchor role, carried a long time. She's allowed to imagine being held too.",
  "The chapter of carrying it alone is closing. A softer year doesn't need to be earned, just chosen.",
];

const MONTH_NUMBERS = {
  january: "01", february: "02", march: "03", april: "04",
  may: "05", june: "06", july: "07", august: "08",
  september: "09", october: "10", november: "11", december: "12",
};

const BUFFER_GRAPHQL_URL = "https://api.buffer.com/graphql";

function requireEnv(name) {
  const v = process.env[name];
  if (!v) {
    console.error(`Missing required environment variable: ${name}`);
    process.exit(1);
  }
  return v;
}

// ---------------------------------------------------------------------------
// Google Drive helpers
// ---------------------------------------------------------------------------
async function listSubfolders(folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `\'${folderId}\' in parents and mimeType = \'application/vnd.google-apps.folder\' and trashed = false`
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("key", DRIVE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Drive folder list failed for ${folderId}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.files || [];
}

async function listDriveFolderFiles(folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set("q", `\'${folderId}\' in parents and mimeType = \'image/png\' and trashed = false`);
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "100");
  url.searchParams.set("key", DRIVE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Drive file list failed for folder ${folderId}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  return data.files || [];
}

// Lists ALL images (any type) directly under a folder, sorted naturally.
// Used for the flat PROMO and COACHING libraries.
async function listDriveImagesFlat(folderId) {
  const url = new URL("https://www.googleapis.com/drive/v3/files");
  url.searchParams.set(
    "q",
    `\'${folderId}\' in parents and mimeType contains \'image/\' and trashed = false`
  );
  url.searchParams.set("fields", "files(id,name)");
  url.searchParams.set("pageSize", "1000");
  url.searchParams.set("key", DRIVE_API_KEY);

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Drive file list failed for ${folderId}: ${res.status} ${await res.text()}`);
  }
  const data = await res.json();
  const files = data.files || [];
  return files.sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }));
}

// Parses "03_aug03_american-family-day.png" -> { day: 3, slug: "american-family-day" }
function parseFilename(name) {
  const m = name.match(/^(\d{1,2})_[a-z]+\d{1,2}_(.+)\.png$/i);
  if (!m) return null;
  return { day: parseInt(m[1], 10), slug: m[2] };
}

function titleFromSlug(slug) {
  return slug
    .split("-")
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(" ");
}

// Discovers LAYA_ROOT_FOLDER_ID/<year>/<month>/*.png and builds the MAIN
// content calendar: { "2026-08-03": { fileId, title }, ... }
async function buildMainCalendar() {
  const calendar = {};
  const yearFolders = await listSubfolders(ROOT_FOLDER_ID);

  for (const yearFolder of yearFolders) {
    if (!/^\d{4}$/.test(yearFolder.name)) {
      console.warn(`Skipping non-year folder under LAYA root: ${yearFolder.name}`);
      continue;
    }
    const year = yearFolder.name;
    const monthFolders = await listSubfolders(yearFolder.id);

    for (const monthFolder of monthFolders) {
      const monthKey = monthFolder.name.toLowerCase();
      const monthNum = MONTH_NUMBERS[monthKey];
      if (!monthNum) {
        console.warn(`Skipping unrecognized month folder: ${year}/${monthFolder.name}`);
        continue;
      }

      const files = await listDriveFolderFiles(monthFolder.id);
      for (const f of files) {
        const parsed = parseFilename(f.name);
        if (!parsed) {
          console.warn(`Skipping file with unexpected name: ${year}/${monthFolder.name}/${f.name}`);
          continue;
        }
        const dateKey = `${year}-${monthNum}-${String(parsed.day).padStart(2, "0")}`;
        calendar[dateKey] = { fileId: f.id, title: titleFromSlug(parsed.slug) };
      }
    }
  }

  return calendar;
}

// ---------------------------------------------------------------------------
// PROMO / COACHING track helpers (fixed epoch grids, same technique as Loka)
// ---------------------------------------------------------------------------
const PROMO_INTERVAL_MS = PROMO_INTERVAL_HOURS * 3600000;
const COACHING_INTERVAL_MS = COACHING_INTERVAL_HOURS * 3600000;

function slotIndexForTime(date, epochStart, intervalMs) {
  return Math.floor((date.getTime() - epochStart.getTime()) / intervalMs);
}

function timeForSlotIndex(slotIndex, epochStart, intervalMs) {
  return new Date(epochStart.getTime() + slotIndex * intervalMs);
}

// ---------------------------------------------------------------------------
// Buffer GraphQL helpers
// ---------------------------------------------------------------------------
async function bufferRequest(query, variables) {
  const res = await fetch(BUFFER_GRAPHQL_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${BUFFER_API_KEY}`,
    },
    body: JSON.stringify({ query, variables }),
  });
  const data = await res.json();
  if (data.errors) {
    throw new Error(`Buffer API error: ${JSON.stringify(data.errors)}`);
  }
  return data.data;
}

async function getChannelServices(channelIds) {
  const query = `
    query Channels($organizationId: OrganizationId!) {
      channels(input: { organizationId: $organizationId }) {
        id
        service
      }
    }
  `;
  const data = await bufferRequest(query, { organizationId: ORG_ID });
  const map = {};
  for (const ch of data.channels) {
    if (channelIds.includes(ch.id)) map[ch.id] = ch.service;
  }
  return map;
}

async function getOrgScheduledPostLimit() {
  const query = `
    query Account {
      account {
        organizations {
          id
          limits { scheduledPosts }
        }
      }
    }
  `;
  const data = await bufferRequest(query, {});
  const org = data.account.organizations.find((o) => o.id === ORG_ID);
  return org ? org.limits.scheduledPosts : 3;
}

// Returns [{ dueAt: Date, text: string }] for every currently-scheduled
// post on the channel, so we can classify each into MAIN / PROMO / COACHING.
async function getScheduledPosts(channelId) {
  const query = `
    query Posts($organizationId: OrganizationId!, $channelIds: [ChannelId!]) {
      posts(input: { organizationId: $organizationId, filter: { channelIds: $channelIds, status: [scheduled] } }, first: 100) {
        edges { node { dueAt text } }
      }
    }
  `;
  const data = await bufferRequest(query, { organizationId: ORG_ID, channelIds: [channelId] });
  return data.posts.edges.map((e) => ({
    dueAt: new Date(e.node.dueAt),
    text: e.node.text || "",
  }));
}

async function createPost({ channelId, service, fileId, title, dueAtIso }) {
  const mutation = `
    mutation CreatePost($input: CreatePostInput!) {
      createPost(input: $input) {
        ... on PostActionSuccess { post { id status dueAt } }
        ... on LimitReachedError { message }
        ... on InvalidInputError { message }
        ... on UnexpectedError { message }
      }
    }
  `;
  const input = {
    channelId,
    mode: "customScheduled",
    schedulingType: "automatic",
    dueAt: dueAtIso,
    text: title || undefined,
    assets: [
      {
        image: {
          url: `https://lh3.googleusercontent.com/d/${fileId}`,
          metadata: { altText: title || "LAYA" },
        },
      },
    ],
  };

  // Facebook and Instagram require an explicit post "type" -- applies to
  // ALL THREE tracks, since it's a per-network requirement, not a
  // per-content-type one.
  if (service === "facebook") {
    input.metadata = { facebook: { type: "post" } };
  } else if (service === "instagram") {
    input.metadata = { instagram: { type: "post", shouldShareToFeed: true } };
  }
  // Threads doesn't require an explicit type -- leave as-is.

  if (DRY_RUN) {
    console.log(`[DRY RUN] Would create post: channel=${channelId} (${service}) dueAt=${dueAtIso} title="${title}"`);
    return;
  }
  const data = await bufferRequest(mutation, { input });
  const payload = data.createPost;
  if (payload.message) {
    throw new Error(`createPost failed: ${payload.message}`);
  }
  console.log(`Scheduled: channel=${channelId} (${service}) dueAt=${dueAtIso} title="${title}" -> post ${payload.post.id}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------
async function main() {
  console.log(`Run started ${new Date().toISOString()}${DRY_RUN ? " [DRY RUN]" : ""}`);

  const mainCalendar = await buildMainCalendar();
  const sortedMainDates = Object.keys(mainCalendar).sort();
  console.log(`MAIN: loaded ${sortedMainDates.length} days of dated content from Drive.`);

  const promoImages = await listDriveImagesFlat(PROMO_ROOT_FOLDER_ID);
  console.log(`PROMO: loaded ${promoImages.length} images from Drive.`);

  const coachingImages = await listDriveImagesFlat(COACHING_ROOT_FOLDER_ID);
  console.log(`COACHING: loaded ${coachingImages.length} images from Drive.`);
  if (coachingImages.length !== COACHING_CAPTIONS.length) {
    console.warn(
      `  Warning: ${coachingImages.length} COACHING images but ${COACHING_CAPTIONS.length} captions -- captions will be reused/cycled by index, double check the Drive folder matches day_001..day_${String(COACHING_CAPTIONS.length).padStart(3,"0")}.`
    );
  }

  const limit = await getOrgScheduledPostLimit();
  console.log(`Buffer scheduled-post limit per channel: ${limit}`);

  const services = await getChannelServices(CHANNEL_IDS);

  for (const channelId of CHANNEL_IDS) {
    const service = services[channelId] || "unknown";
    const channelMinDate = minDateFor(channelId);
    console.log(`\nChannel ${channelId} (${service}) -- MAIN minimum date: ${channelMinDate || "(none -- starts today)"}`);

    let scheduled;
    try {
      scheduled = await getScheduledPosts(channelId);
    } catch (err) {
      console.error(`  Skipping channel: couldn't read current schedule (${err.message})`);
      continue;
    }

    const promoScheduled = scheduled.filter((p) => p.text === PROMO_CAPTION);
    const coachingScheduled = scheduled.filter(
      (p) => p.text !== PROMO_CAPTION && p.text.includes(COACHING_CTA_MARKER)
    );
    const mainScheduled = scheduled.filter(
      (p) => p.text !== PROMO_CAPTION && !p.text.includes(COACHING_CTA_MARKER)
    );
    const scheduledMainDates = new Set(mainScheduled.map((p) => p.dueAt.toISOString().slice(0, 10)));

    console.log(
      `  ${scheduled.length}/${limit} total slots used (MAIN: ${mainScheduled.length}, PROMO: ${promoScheduled.length}, COACHING: ${coachingScheduled.length}).`
    );

    const slotsToFill = limit - scheduled.length;
    if (slotsToFill <= 0) {
      console.log("  Already at limit. Nothing to add this run.");
      continue;
    }

    // MAIN candidates: real calendar dates, respecting this channel's
    // min-date, not already scheduled.
    const mainCandidateDates = sortedMainDates.filter(
      (d) => (!channelMinDate || d >= channelMinDate) && !scheduledMainDates.has(d)
    );
    let mainPointer = 0;

    // PROMO candidates: next empty slot on the fixed grid.
    const nowPromoSlot = Math.ceil(
      (Date.now() + LEAD_BUFFER_MS - PROMO_EPOCH_START.getTime()) / PROMO_INTERVAL_MS
    );
    const latestPromoSlot = promoScheduled.length
      ? Math.max(...promoScheduled.map((p) => slotIndexForTime(p.dueAt, PROMO_EPOCH_START, PROMO_INTERVAL_MS)))
      : -1;
    let nextPromoSlot = Math.max(nowPromoSlot, latestPromoSlot + 1);

    // COACHING candidates: next empty slot on its own fixed grid.
    const nowCoachingSlot = Math.ceil(
      (Date.now() + LEAD_BUFFER_MS - COACHING_EPOCH_START.getTime()) / COACHING_INTERVAL_MS
    );
    const latestCoachingSlot = coachingScheduled.length
      ? Math.max(...coachingScheduled.map((p) => slotIndexForTime(p.dueAt, COACHING_EPOCH_START, COACHING_INTERVAL_MS)))
      : -1;
    let nextCoachingSlot = Math.max(nowCoachingSlot, latestCoachingSlot + 1);

    let filled = 0;
    let consecutiveFailures = 0;
    const MAX_CONSECUTIVE_FAILURES = 3;

    while (filled < slotsToFill) {
      // Skip any MAIN candidate whose real due time has already passed --
      // possible near midnight UTC since MAIN posts at 7 PM Manila, not UTC.
      while (
        mainPointer < mainCandidateDates.length &&
        new Date(`${mainCandidateDates[mainPointer]}T${POST_TIME_LOCAL}${POST_UTC_OFFSET}`).getTime() <
          Date.now() + LEAD_BUFFER_MS
      ) {
        console.log(`  Skipping stale MAIN date ${mainCandidateDates[mainPointer]} (due time already passed).`);
        mainPointer++;
      }

      const mainAvailable = mainPointer < mainCandidateDates.length;
      const mainDateKey = mainAvailable ? mainCandidateDates[mainPointer] : null;
      const mainTime = mainAvailable
        ? new Date(`${mainDateKey}T${POST_TIME_LOCAL}${POST_UTC_OFFSET}`)
        : null;
      const promoTime = timeForSlotIndex(nextPromoSlot, PROMO_EPOCH_START, PROMO_INTERVAL_MS);
      const coachingTime = timeForSlotIndex(nextCoachingSlot, COACHING_EPOCH_START, COACHING_INTERVAL_MS);

      // Pick whichever of the three next candidates is chronologically
      // earliest -- this is what actually splits the shared cap between
      // all three tracks instead of one starving the others.
      let winner = "PROMO";
      let winnerTime = promoTime;
      if (mainAvailable && mainTime.getTime() < winnerTime.getTime()) {
        winner = "MAIN";
        winnerTime = mainTime;
      }
      if (coachingTime.getTime() < winnerTime.getTime()) {
        winner = "COACHING";
        winnerTime = coachingTime;
      }

      let fileId, title, dueAt;
      if (winner === "MAIN") {
        const entry = mainCalendar[mainDateKey];
        fileId = entry.fileId;
        title = entry.title;
        dueAt = mainTime;
      } else if (winner === "COACHING") {
        const imageIndex = ((nextCoachingSlot % coachingImages.length) + coachingImages.length) % coachingImages.length;
        const captionIndex = imageIndex % COACHING_CAPTIONS.length;
        fileId = coachingImages[imageIndex].id;
        title = `${COACHING_CAPTIONS[captionIndex]}\n\n${COACHING_CTA}`;
        dueAt = coachingTime;
      } else {
        const imageIndex = ((nextPromoSlot % promoImages.length) + promoImages.length) % promoImages.length;
        fileId = promoImages[imageIndex].id;
        title = PROMO_CAPTION;
        dueAt = promoTime;
      }

      const dueAtIso = dueAt.toISOString();

      try {
        await createPost({ channelId, service, fileId, title, dueAtIso });
        console.log(`  (${winner})`);
        filled++;
        consecutiveFailures = 0;
      } catch (err) {
        console.error(`  Failed to schedule ${winner} slot (${dueAtIso}): ${err.message}`);
        consecutiveFailures++;
        if (/limit/i.test(err.message)) {
          console.log("  Buffer reports the scheduled-post limit is reached. Stopping this channel.");
          break;
        }
        if (consecutiveFailures >= MAX_CONSECUTIVE_FAILURES) {
          console.error(`  Stopping this channel after ${consecutiveFailures} consecutive failures.`);
          break;
        }
      }

      if (winner === "MAIN") {
        mainPointer++;
      } else if (winner === "COACHING") {
        nextCoachingSlot++;
      } else {
        nextPromoSlot++;
      }
    }

    console.log(`  Filled ${filled} slot(s) this run.`);
  }

  console.log("\nRun complete.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
