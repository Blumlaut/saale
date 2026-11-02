/**
 * The languages Whisper decodes, as the codes a transcription request names.
 *
 * Taken from Whisper's own language table: the codes are what the transcription
 * server accepts in its `language` field.
 */

export interface VoiceLanguage {
  code: string;
  label: string;
}

export const VOICE_LANGUAGES: readonly VoiceLanguage[] = [
  { code: "en", label: "English" },
  { code: "zh", label: "Chinese" },
  { code: "de", label: "German" },
  { code: "es", label: "Spanish" },
  { code: "ru", label: "Russian" },
  { code: "ko", label: "Korean" },
  { code: "fr", label: "French" },
  { code: "ja", label: "Japanese" },
  { code: "pt", label: "Portuguese" },
  { code: "tr", label: "Turkish" },
  { code: "pl", label: "Polish" },
  { code: "ca", label: "Catalan" },
  { code: "nl", label: "Dutch" },
  { code: "ar", label: "Arabic" },
  { code: "sv", label: "Swedish" },
  { code: "it", label: "Italian" },
  { code: "id", label: "Indonesian" },
  { code: "hi", label: "Hindi" },
  { code: "fi", label: "Finnish" },
  { code: "vi", label: "Vietnamese" },
  { code: "he", label: "Hebrew" },
  { code: "uk", label: "Ukrainian" },
  { code: "el", label: "Greek" },
  { code: "ms", label: "Malay" },
  { code: "cs", label: "Czech" },
  { code: "ro", label: "Romanian" },
  { code: "da", label: "Danish" },
  { code: "hu", label: "Hungarian" },
  { code: "ta", label: "Tamil" },
  { code: "no", label: "Norwegian" },
  { code: "th", label: "Thai" },
  { code: "ur", label: "Urdu" },
  { code: "hr", label: "Croatian" },
  { code: "bg", label: "Bulgarian" },
  { code: "lt", label: "Lithuanian" },
  { code: "la", label: "Latin" },
  { code: "mi", label: "Maori" },
  { code: "ml", label: "Malayalam" },
  { code: "cy", label: "Welsh" },
  { code: "sk", label: "Slovak" },
  { code: "te", label: "Telugu" },
  { code: "fa", label: "Persian" },
  { code: "lv", label: "Latvian" },
  { code: "bn", label: "Bengali" },
  { code: "sr", label: "Serbian" },
  { code: "az", label: "Azerbaijani" },
  { code: "sl", label: "Slovenian" },
  { code: "kn", label: "Kannada" },
  { code: "et", label: "Estonian" },
  { code: "mk", label: "Macedonian" },
  { code: "br", label: "Breton" },
  { code: "eu", label: "Basque" },
  { code: "is", label: "Icelandic" },
  { code: "hy", label: "Armenian" },
  { code: "ne", label: "Nepali" },
  { code: "mn", label: "Mongolian" },
  { code: "bs", label: "Bosnian" },
  { code: "kk", label: "Kazakh" },
  { code: "sq", label: "Albanian" },
  { code: "sw", label: "Swahili" },
  { code: "gl", label: "Galician" },
  { code: "mr", label: "Marathi" },
  { code: "pa", label: "Punjabi" },
  { code: "si", label: "Sinhala" },
  { code: "km", label: "Khmer" },
  { code: "sn", label: "Shona" },
  { code: "yo", label: "Yoruba" },
  { code: "so", label: "Somali" },
  { code: "af", label: "Afrikaans" },
  { code: "oc", label: "Occitan" },
  { code: "ka", label: "Georgian" },
  { code: "be", label: "Belarusian" },
  { code: "tg", label: "Tajik" },
  { code: "sd", label: "Sindhi" },
  { code: "gu", label: "Gujarati" },
  { code: "am", label: "Amharic" },
  { code: "yi", label: "Yiddish" },
  { code: "lo", label: "Lao" },
  { code: "uz", label: "Uzbek" },
  { code: "fo", label: "Faroese" },
  { code: "ht", label: "Haitian Creole" },
  { code: "ps", label: "Pashto" },
  { code: "tk", label: "Turkmen" },
  { code: "nn", label: "Nynorsk" },
  { code: "mt", label: "Maltese" },
  { code: "sa", label: "Sanskrit" },
  { code: "lb", label: "Luxembourgish" },
  { code: "my", label: "Myanmar" },
  { code: "bo", label: "Tibetan" },
  { code: "tl", label: "Tagalog" },
  { code: "mg", label: "Malagasy" },
  { code: "as", label: "Assamese" },
  { code: "tt", label: "Tatar" },
  { code: "haw", label: "Hawaiian" },
  { code: "ln", label: "Lingala" },
  { code: "ha", label: "Hausa" },
  { code: "ba", label: "Bashkir" },
  { code: "jw", label: "Javanese" },
  { code: "su", label: "Sundanese" },
  { code: "yue", label: "Cantonese" },
];

const BY_CODE = new Map(VOICE_LANGUAGES.map((language) => [language.code, language]));

/** Whether a code is one Whisper decodes. */
export function isVoiceLanguage(code: string): boolean {
  return BY_CODE.has(code);
}

/** The name to show for a code, or the code itself when it is not a known one. */
export function voiceLanguageLabel(code: string): string {
  return BY_CODE.get(code)?.label ?? code;
}
