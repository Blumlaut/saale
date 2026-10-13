/**
 * Default member names.
 *
 * A member's name is also the handle other members address it by (`@name`), so
 * the default has to be a word a model can spell back — short, lowercase, one
 * token. This is a bundled wordlist rather than a generated phrase for exactly
 * that reason.
 *
 * Source: the EFF short wordlist ("eff_short_wordlist_1"), 1296 words chosen for
 * human-readable random identifiers, by the Electronic Frontier Foundation under
 * CC-BY-3.0 — <https://www.eff.org/files/2016/09/08/eff_short_wordlist_1.txt>.
 * The 1113 entries below are that list after:
 *
 *   1. lowercasing and dropping anything not `[a-z]+` (1295 left),
 *   2. dropping reserved handles (`user`, `all`, `system`), Saale tool names and
 *      council vocabulary (`vote`, `message`, `member`, …) that would read
 *      confusingly in a prompt, and month/weekday names (1224 left),
 *   3. dropping the words AFINN-111 scores as negative valence, and a
 *      hand-checked blocklist of brands, proper nouns, insults and bodily words
 *      that read badly as a person's name (1113 left).
 *
 * The result is a pool of short concrete words — `acorn`, `blade`, `zebra`. To
 * extend or replace it, edit the pool below; the tests assert every entry is a
 * usable handle.
 */

/**
 * The pool, space-separated to keep the file small — split once at load rather
 * than stored as 1113 string literals.
 */
const WORDS = `acorn acre acts afar affix aged agile aging ahead aide aids aim ajar alias alike alive aloe
aloft aloha amend amino ample amuse angel angle ankle apple apron aqua area arena argue arise
armed armor army aroma array art ashen ashes atlas atom attic audio avert avoid awake award
awoke axis bacon badge bagel baggy baked baker balmy banjo barge barn basil bask batch bath
baton bats blade blank blast blaze bleak blend bless blimp blink bloat blob blot blunt blurt
blush boat body boil bolt boned boney bonus bony book booth boots both boxer breed brick bride
brim bring brink brisk broad broil brook broom brush buck bud bulge bulk bunch bunny bunt bush
busy buzz cable cache cadet cage cake calm cameo canal candy cane canon cape card cargo carol
carry carve case cash cause cedar chain chair chant charm chase cheek cheer chef chess chest
chew chief chili chill chip chomp chop chow chuck chunk churn chute cider cinch city civic civil
clad claim clamp clap clasp class claw clay clean clear cleat cleft clerk click cling clink clip
cloak clock clone cloth cloud clump coach coast coat cod coil cola cold colt come comic comma
cone cope copy coral cork cost cot couch cough cover cozy craft crane crank crate crave crawl
creme crepe crept crib crisp crook crop cross crowd crown crumb crush crust cub cupid cure curl
curry curve curvy cushy cut cycle dab dad daily dairy daisy dance dart dash data date dawn deal
dean debit debug decaf decal deck decor decoy deed delay denim dense depth derby desk dial diary
dice dig dill dime dimly diner disco dish disk ditch dock dodge doing doll dome donor donut dose
dot dove down dowry doze drama drank draw dress dried drift drill drive drone drove drum dry
duck duct dug duke duo dusk dust duty dwarf dwell eagle early earth easel east eaten eats ebony
echo edge eel eject elbow elder elf elk elm elope elude elves emit empty emu enter entry envoy
equal erase erupt essay etch evade even evict evoke exact exit fable faced fact fade fall false
fancy fang fax feast feed femur fence fend ferry fetch fiber fifth fifty film final finch fit
five flag flaky flame flap flask fled flick fling flint flip float flock floss flyer foam fog
foil folic folk food found fox foyer frame fresh fried frill frisk from front frost frown froze
fruit gains gala game gap gas gave gear gecko gem genre gift gig gills given giver glad glass
glide gloss glove glow glue going golf gong good gooey gown grab grain grant grape graph grasp
grass gravy gray green greet grew grid grill grip grit groom growl guide gulf gulp gummy guru
gut guy habit half halo halt happy hash hasty hatch haven hazel hazy heap heat hedge hefty help
herbs hers hub hug hula hull human humid hung hunt hurry hush hut ice icing icon icy igloo image
ion iron issue item ivory ivy jab jaws jazz jelly jet jiffy job jog jolly jolt jot joy judge
juice juicy jumbo jump juror jury keep kept kick kilt king kite kitty kiwi knee knelt koala kung
ladle lady lair lake lance land lapel large lash lasso last latch late lazy left legal lemon
lend lens lent level lever lid life lift lilac lily limb limes line lint lion lip lived liver
lunar lunch lung lure lying lyric maker malt mama mango manor many map mardi marry match mate
math mocha moist mom moody mop morse most motor motto mount mouse mouth move movie mower mud
mulch mule mural muse music musky mute nacho nail nanny nap navy near neat neon nest net next
niece ninth oak oasis oat ocean oil old olive omen onion only opal open opera opt otter ounce
outer oval oven owl ozone pace pager palm panda pants paper park party pasta patch path patio
payer pecan penny pep perch perky perm petal petri petty photo plank plant plaza plead plot plow
pluck plug plus poach pod poem poet pogo point poise poker polar polka polo pond pony poppy pork
poser pouch pound pout power press print prior prism prize probe prong proof props prune pry
pull pulp pulse puma punch pupil puppy purr purse push putt quake query quiet quill quilt quit
quota quote race rack radar radio raft raid rail rake rally ramp ranch range rank raven reach
react ream rebel recap relax relay relic remix repay repel reply rerun reset rhyme rice rich
ride rigid rinse ripen rise ritzy rival river roast robe robin rock rogue roman romp rope rover
royal ruby rule runny rush rust sage said saint salad salon salsa salt same sandy satin sauna
saved savor sax say scale scan scarf scoop scoot scope score scout scrap scrub scuba scuff sect
sedan self send sepia serve seven shack shade shady shaft shape share sharp shed sheep sheet
shelf shell shine shiny ship shirt shop shore shout shove shown showy shred shrug shush shut shy
sift silk silly silo sip siren sixth size skate skew skid skier skies skip skirt skit sky slab
slack slain slang slate slaw sled sleek sleep sleet slept slice slick slimy sling slip slit slot
slug small smash smile smirk snack snap snare sniff snore snout snowy speak speed spend spent
spew spied spill spiny spoke spool spoon sport spot spout spray spree spur squad squat squid
stack staff stage stamp stand stark start stash state stays steam steep stem step stew stick
stir stock stole stomp stony stood stool stoop storm stout stove straw stray strut stud stuff
stump stung suds sugar surf sushi swab swan swarm sway sweep swell swept swim swing swipe swirl
swoop swore syrup tacky taco tag take tall talon tamer tank taper taps tarot tart taste tasty
taunt thank thaw theme thigh thing think thorn those thumb thump thus tiara tidal tidy tiger
tile tilt tint tiny trace track trade train trait trap tray treat tree trek trend trial tribe
trick trio trout truce truck trunk try tug tulip tummy turf tusk tutor tutu tux tweak tweet
twice twine twins twirl twist uncle uncut undo unify union unit untie upon upper urban used
usher utter value vapor vegan venue verse vest veto vice video view visa visor vixen vocal voice
void volt voter vowel wad wafer wager wages wagon wake walk wand wasp watch water wavy wheat
whole whoop wick widen widow width wife wifi wilt wind wing wink wipe wired wiry wise wish wispy
wok wolf wool word work woven wrist yam yard year yeast yield yodel yoga yoyo yummy zebra zero
zesty zippy zone zoom`;

/** Every name a member may be given by default, in source order. */
export const MEMBER_NAME_POOL: readonly string[] = WORDS.split(/\s+/);

/**
 * Number a name that cannot be drawn from the pool.
 *
 * Only reachable when every pool entry is taken, which a council of at most
 * `MAX_MEMBERS` never reaches — it exists so the caller always gets a free,
 * valid handle rather than a duplicate the unique index would reject.
 */
function numberedName(base: string, taken: Set<string>): string {
  for (let suffix = 2; ; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/**
 * Pick a name no member of this council is using.
 *
 * `taken` is compared case-insensitively (handles resolve that way) and
 * `random` is injectable so the choice is testable.
 */
export function pickMemberName(
  taken: Iterable<string> = [],
  random: () => number = Math.random,
): string {
  const used = new Set([...taken].map((name) => name.trim().toLowerCase()));
  const free = MEMBER_NAME_POOL.filter((name) => !used.has(name));
  if (free.length === 0) {
    return numberedName(MEMBER_NAME_POOL[Math.floor(random() * MEMBER_NAME_POOL.length)]!, used);
  }
  const index = Math.min(free.length - 1, Math.floor(random() * free.length));
  return free[index]!;
}

/** Pick `count` distinct free names — for a council created with members at once. */
export function pickMemberNames(
  count: number,
  taken: Iterable<string> = [],
  random: () => number = Math.random,
): string[] {
  const used = new Set([...taken].map((name) => name.trim().toLowerCase()));
  const names: string[] = [];
  for (let i = 0; i < count; i += 1) {
    const name = pickMemberName(used, random);
    names.push(name);
    used.add(name);
  }
  return names;
}
