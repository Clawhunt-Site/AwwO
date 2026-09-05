/**
 * Tag-Driven Generator — Tag Categories & Options
 *
 * 5 categories with real Dreamy prompt fragments.
 * Each tag has an ID, display label, and prompt fragment for assembly.
 */

export interface Tag {
  id: string;
  label: string;
  promptFragment: string;
}

export interface Category {
  id: string;
  label: string;
  emoji: string;
}

export const CATEGORIES: Category[] = [
  { id: 'sexAct', label: 'Sex Act', emoji: '🔥' },
  { id: 'position', label: 'Position', emoji: '✦' },
  { id: 'camera', label: 'Camera', emoji: '📹' },
  { id: 'reaction', label: 'Reaction', emoji: '♡' },
  { id: 'scene', label: 'Scene', emoji: '📍' },
];

export const TAG_OPTIONS: Record<string, Tag[]> = {
  sexAct: [
    { id: 'slow-penetration', label: 'Slow Penetration', promptFragment: 'he slowly pushes his cock inside her, inch by inch, stretching her open as she gasps at each movement' },
    { id: 'fast-thrusting', label: 'Fast Thrusting', promptFragment: 'he pounds into her with rapid powerful thrusts, hips slamming against her, skin slapping with each stroke' },
    { id: 'blowjob', label: 'Blowjob / Oral', promptFragment: 'she wraps her lips around his cock, sliding him in and out of her mouth with drool dripping from her chin' },
    { id: 'deepthroat', label: 'Deepthroat', promptFragment: 'she takes his entire length deep into her throat, eyes watering, gagging softly as saliva streams down' },
    { id: 'handjob', label: 'Handjob', promptFragment: 'she grips his shaft with both hands, stroking firmly up and down with a tight twisting motion' },
    { id: 'grinding', label: 'Grinding', promptFragment: 'she grinds on top of him, rolling her hips in slow deliberate circles, pressing him deeper inside with each rotation' },
    { id: 'creampie', label: 'Creampie', promptFragment: 'he cums deep inside her, thick cum leaking out from her stretched opening and dripping down her thighs' },
    { id: 'anal', label: 'Anal', promptFragment: 'he pushes into her tight ass slowly, her hole stretching around his cock as she moans and grips the sheets' },
  ],
  position: [
    { id: 'missionary', label: 'Missionary', promptFragment: 'she lies on her back in missionary position, legs wrapped tightly around his waist, pulling him deeper inside her' },
    { id: 'legs-spread', label: 'Legs Spread', promptFragment: 'she lies back with her legs spread wide open in an M-shape, fully exposed, her pussy visible and inviting' },
    { id: 'legs-on-shoulders', label: 'Legs On Shoulders', promptFragment: 'she lies back with both legs resting up on his shoulders, body folded, allowing deep penetration at a steep angle' },
    { id: 'cowgirl', label: 'Cowgirl / Riding', promptFragment: 'she rides on top in cowgirl position, sitting upright with hands on his chest, bouncing her hips up and down on his cock' },
    { id: 'doggy', label: 'Doggy Style', promptFragment: 'she is on all fours with her ass raised high and back arched, taken from behind in doggy style' },
    { id: 'standing-behind', label: 'Standing Behind', promptFragment: 'she is bent forward while standing, gripping the edge of a surface as he takes her from behind, holding her hips' },
  ],
  camera: [
    { id: 'overhead', label: 'Overhead Top-Down', promptFragment: 'shot from directly above looking straight down on her body, showing her full figure spread out beneath him' },
    { id: 'pov-below', label: 'POV From Below', promptFragment: 'POV angle from below looking up at her, her breasts swaying above, her face and expressions fully visible' },
    { id: 'low-angle', label: 'Low-Angle', promptFragment: 'low-angle shot looking up along her body, emphasizing her curves, breasts, and the motion of her hips' },
    { id: 'close-up-face', label: 'Close-Up Face', promptFragment: 'extreme close-up on her face, capturing every micro-expression, parted lips, and glistening skin in detail' },
    { id: 'close-up-action', label: 'Close-Up Action', promptFragment: 'tight close-up on the point of penetration, showing his cock entering her, the explicit action visible in full detail' },
  ],
  reaction: [
    { id: 'tongue-out', label: 'Tongue Out Drool', promptFragment: 'as the intensity builds, her tongue hangs out with drool sliding down her chin and neck, completely lost in overwhelming pleasure' },
    { id: 'moans', label: 'Intermittent Moans', promptFragment: 'with each thrust she moans louder, mouth hanging open, breathing heavily, crying out between gasps as the pace increases' },
    { id: 'hazy-eyes', label: 'Hazy Eyes', promptFragment: 'as intercourse continues, her eyes become glazed over and unfocused, staring blankly with a dazed thoroughly pleasured expression' },
    { id: 'alluring', label: 'Alluring Expression', promptFragment: 'while being fucked, she gazes directly at the camera with a seductive captivating expression, lips parted, completely inviting' },
    { id: 'eyes-rolling', label: 'Eyes Rolling Back', promptFragment: 'as she reaches orgasm, her eyes roll back into her head, eyelids fluttering half-closed as intense climax washes over her body' },
    { id: 'biting-lip', label: 'Biting Lower Lip', promptFragment: 'throughout the act she bites her lower lip hard, trying to suppress her moans, face tense and flushed with building pleasure' },
    { id: 'flushed-cheeks', label: 'Flushed Cheeks', promptFragment: 'as arousal intensifies, her cheeks and chest flush deep red, skin glistening with sweat, body radiating heat from the exertion' },
  ],
  scene: [
    { id: 'dim-bedroom', label: 'Dim Bedroom Night', promptFragment: 'in a dimly lit bedroom at night, warm amber light from a bedside lamp, rumpled silk sheets beneath her body' },
    { id: 'luxury-hotel', label: 'Luxury Hotel', promptFragment: 'in a luxurious hotel suite with a king-size bed, crisp white sheets, floor-to-ceiling windows showing city lights' },
    { id: 'steamy-shower', label: 'Steamy Shower', promptFragment: 'inside a steamy glass-walled shower, hot water cascading over her body, tiles and glass fogged with condensation' },
    { id: 'pool-sunset', label: 'Pool Sunset', promptFragment: 'beside a shimmering pool at golden hour, warm sunset light casting long glowing shadows across her wet skin' },
    { id: 'office-after-hours', label: 'Office After Hours', promptFragment: 'bent over a polished mahogany office desk after hours, papers scattered beneath her, blinds half-drawn letting in streetlight' },
    { id: 'car-back-seat', label: 'Car Back Seat', promptFragment: 'in the cramped back seat of a car at night, windows completely fogged up, leather seats creaking beneath her' },
  ],
};

/**
 * Assemble the final prompt from selected tags.
 * Rule: {sex_act}, {position}, {camera}, {reaction}, {scene}, realistic, cinematic lighting, ultra-detailed
 * Empty slots are skipped.
 */
export function assemblePrompt(selections: Record<string, string | undefined>): string {
  const fragments: string[] = [];

  CATEGORIES.forEach((category) => {
    const selectedTagId = selections[category.id];
    if (selectedTagId) {
      const tag = TAG_OPTIONS[category.id]?.find((t) => t.id === selectedTagId);
      if (tag) {
        fragments.push(tag.promptFragment);
      }
    }
  });

  if (fragments.length === 0) {
    return '';
  }

  return `${fragments.join(', ')}, realistic, cinematic lighting, ultra-detailed`;
}

/**
 * Roll one random tag per category.
 */
export function rollAllTags(): Record<string, string> {
  const rolled: Record<string, string> = {};

  CATEGORIES.forEach((category) => {
    const options = TAG_OPTIONS[category.id];
    if (options && options.length > 0) {
      const randomIndex = Math.floor(Math.random() * options.length);
      rolled[category.id] = options[randomIndex].id;
    }
  });

  return rolled;
}
