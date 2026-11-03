/**
 * Transliteration utility: converts Devanagari script (Hindi vernacular) into natural Romanized Hindi (Hinglish)
 * and maps phonetic English-in-Devanagari words into clean English.
 */

const DEV_PATTERN = /[\u0900-\u097F]/;

const DEV_TO_ENGLISH: Record<string, string> = {
  // Pronouns & determiners
  'दिस': 'this', 'दैट': 'that', 'दीज': 'these', 'दोज': 'those', 'इट': 'it', 'इट्स': 'its',
  'आई': 'I', 'यू': 'you', 'माय': 'my', 'मी': 'me', 'वी': 'we', 'दे': 'they', 'योर': 'your',
  'ही': 'he', 'शी': 'she', 'हिम': 'him', 'हर': 'her',
  // Copulas & auxiliary verbs
  'इज': 'is', 'एम': 'am', 'आर': 'are', 'वाज': 'was', 'वर': 'were', 'विल': 'will',
  'कैन': 'can', 'कुड': 'could', 'वुड': 'would', 'शुड': 'should',
  'हैव': 'have', 'हैज': 'has', 'हैड': 'had', 'डू': 'do', 'डज': 'does', 'डिड': 'did',
  // Prepositions & conjunctions
  'एंड': 'and', 'ऑर': 'or', 'बट': 'but', 'सो': 'so', 'फॉर': 'for', 'इन': 'in', 'ऑन': 'on',
  'एट': 'at', 'टू': 'to', 'विद': 'with', 'ऑफ': 'of', 'बाय': 'by', 'फ्रॉम': 'from',
  // Common verbs
  'वांट': 'want', 'वांट्स': 'wants', 'वांटेड': 'wanted', 'नीड': 'need', 'नीड्स': 'needs',
  'लुकिंग': 'looking', 'लुक': 'look', 'सेल': 'sell', 'सेलिंग': 'selling',
  'रेंट': 'rent', 'रेंटिंग': 'renting', 'लीज': 'lease', 'कॉल': 'call', 'गिव': 'give',
  'टेल': 'tell', 'स्पीकिंग': 'speaking', 'थैंक': 'thank', 'थैंक्स': 'thanks',
  'सॉरी': 'sorry', 'हेल्प': 'help', 'कम': 'come', 'गो': 'go',
  // Real estate & commercial vocabulary
  'रेसिडेंशियल': 'residential', 'कमर्शियल': 'commercial',
  'प्रॉपर्टी': 'property', 'अपार्टमेंट': 'apartment', 'फ्लैट': 'flat', 'हाउस': 'house',
  'प्लॉट': 'plot', 'ऑफिस': 'office', 'स्पेस': 'space', 'शॉप': 'shop', 'शोरूम': 'showroom',
  'वेयरहाउस': 'warehouse', 'गोडाउन': 'godown', 'गोदाम': 'godown', 'बीएचके': 'BHK',
  'यूनिट': 'unit', 'फ्लोर': 'floor', 'सेक्टर': 'sector', 'सोसाइटी': 'society', 'प्रोजेक्ट': 'project',
  'बिल्डिंग': 'building', 'प्राइस': 'price', 'रेट': 'rate', 'कॉस्ट': 'cost', 'एरिया': 'area',
  'साइज': 'size', 'स्क्वायर': 'square', 'फीट': 'feet', 'करोड़': 'crore', 'लाख': 'lakh',
  'लोकेशन': 'location', 'नंबर': 'number', 'डिटेल्स': 'details', 'पर्सन': 'person',
  'एड्रेस': 'address', 'फर्निश्ड': 'furnished', 'अनफर्निश्ड': 'unfurnished', 'सेमी': 'semi',
  'रेडी': 'ready', 'अवेलेबल': 'available', 'न्यू': 'new', 'ओल्ड': 'old',
  // Ordinals
  'फर्स्ट': 'first', 'सेकंड': 'second', 'थर्ड': 'third', 'फोर्थ': 'fourth', 'फिफ्थ': 'fifth',
  'सिक्स्थ': 'sixth', 'सेवंथ': 'seventh', 'एइथ': 'eighth', 'नाइंथ': 'ninth', 'टेंथ': 'tenth',
  'ग्राउंड': 'ground', 'बेसमेंट': 'basement',
  // General confirmations & calendar
  'यस': 'yes', 'येस': 'yes', 'नो': 'no', 'श्योर': 'sure', 'प्लीज': 'please',
  'टुमॉरो': 'tomorrow', 'टुमारो': 'tomorrow', 'टुडे': 'today', 'मंडे': 'monday',
  'ट्यूसडे': 'tuesday', 'वेडनेसडे': 'wednesday', 'थर्सडे': 'thursday', 'फ्राइडे': 'friday',
  'सैटरडे': 'saturday', 'संडे': 'sunday', 'इंग्लिश': 'English', 'व्हाट': 'what',
  'नेक्स्ट': 'next', 'वीक': 'week', 'लेटर': 'later', 'बिजी': 'busy', 'बिज़ी': 'busy',
  'ऑलरेडी': 'already', 'रिटर्न्ड': 'returned', 'राइट': 'right', 'करेक्ट': 'correct',
  'नॉट': 'not', 'डोंट': 'dont', 'नेम': 'name', 'इंटरेस्टेड': 'interested', 'ओके': 'okay',
  'हेलो': 'hello', 'हैलो': 'hello', 'हाय': 'hi', 'हे': 'hey',
};

const DEV_TO_HINGLISH: Record<string, string> = {
  // Affirmations & greetings
  'हाँ': 'haan', 'हां': 'haan', 'हाँजी': 'haanji', 'हांजी': 'haanji', 'जी': 'ji', 'हंजी': 'hanji',
  'नहीं': 'nahi', 'नही': 'nahi', 'ना': 'na', 'मत': 'mat',
  'नमस्ते': 'namaste', 'नमस्कार': 'namaskar',
  // Pronouns
  'मेरा': 'mera', 'मेरी': 'meri', 'मेरे': 'mere', 'मुझे': 'mujhe', 'मुझको': 'mujhko',
  'आपका': 'aapka', 'आपकी': 'aapki', 'आपके': 'aapke', 'आपको': 'aapko', 'आप': 'aap',
  'हम': 'hum', 'हमारा': 'hamara', 'हमारी': 'hamari', 'हमारे': 'hamare', 'हमें': 'humein',
  'मैं': 'main', 'मै': 'main', 'यह': 'yeh', 'ये': 'ye', 'वह': 'woh', 'वो': 'wo',
  'इसका': 'iska', 'इसकी': 'iski', 'इसके': 'iske', 'उसका': 'uska', 'उसकी': 'uski', 'उसके': 'uske',
  'अपना': 'apna', 'अपनी': 'apni', 'अपने': 'apne',
  // Question words
  'क्या': 'kya', 'क्यों': 'kyun', 'क्यूँ': 'kyun', 'कहाँ': 'kahan', 'कहा': 'kahan',
  'कब': 'kab', 'कैसे': 'kaise', 'कौन': 'kaun', 'कितना': 'kitna', 'कितनी': 'kitni', 'कितने': 'kitne',
  // Copulas & auxiliary verbs
  'है': 'hai', 'हैं': 'hain', 'हूँ': 'hoon', 'हु': 'hoon', 'था': 'tha', 'थी': 'thi', 'थे': 'the',
  'हो': 'ho', 'होगा': 'hoga', 'होगी': 'hogi', 'होंगे': 'honge',
  // Postpositions
  'का': 'ka', 'की': 'ki', 'के': 'ke', 'को': 'ko', 'से': 'se', 'में': 'mein', 'पे': 'pe', 'पर': 'par', 'ने': 'ne', 'तक': 'tak',
  // Connectives & discourse markers
  'और': 'aur', 'भी': 'bhi', 'तो': 'toh', 'या': 'ya', 'लेकिन': 'lekin', 'मगर': 'magar', 'क्योंकि': 'kyunki',
  'अच्छा': 'achha', 'अच्छी': 'achhi', 'अच्छे': 'achhe', 'ठीक': 'theek', 'सही': 'sahi', 'गलत': 'galat',
  'बिल्कुल': 'bilkul', 'ज़रूर': 'zaroor', 'जरूर': 'zaroor',
  // Core verbs
  'बेचना': 'bechna', 'बेचनी': 'bechni', 'बेचने': 'bechne', 'बेच': 'bech',
  'देना': 'dena', 'देनी': 'deni', 'देने': 'dene', 'दो': 'do', 'दीजिए': 'dijiye',
  'लेना': 'lena', 'लेनी': 'leni', 'लेने': 'lene', 'लो': 'lo', 'लीजिए': 'lijiye',
  'करना': 'karna', 'करनी': 'karni', 'करने': 'karne', 'करो': 'karo', 'कीजिए': 'kijiye', 'कर': 'kar', 'करेंगे': 'karenge',
  'रहा': 'raha', 'रही': 'rahi', 'रहे': 'rahe',
  'सकता': 'sakta', 'सकती': 'sakti', 'सकते': 'sakte',
  'चाहता': 'chahta', 'चाहती': 'chahti', 'चाहते': 'chahte', 'चाहिए': 'chahiye',
  'बताना': 'batana', 'बताओ': 'batao', 'बताइए': 'bataiye', 'बताएं': 'batayein',
  'बोलना': 'bolna', 'बोलो': 'bolo', 'बोलिए': 'boliye', 'बोल': 'bol',
  'समझ': 'samajh', 'गया': 'gaya', 'गई': 'gayi', 'गए': 'gaye',
  'खाली': 'khaali', 'किराया': 'kiraya', 'किराये': 'kiraye',
  'दुकान': 'dukan', 'मकान': 'makaan', 'घर': 'ghar', 'कमरा': 'kamra',
  'नाम': 'naam', 'काम': 'kaam', 'बात': 'baat', 'समय': 'samay',
  'बाद': 'baad', 'पहले': 'pehle', 'अभी': 'abhi', 'आज': 'aaj', 'कल': 'kal',
};

const CONSONANTS: Record<string, string> = {
  'क': 'k', 'ख': 'kh', 'ग': 'g', 'घ': 'gh', 'ङ': 'ng',
  'च': 'ch', 'छ': 'chh', 'ज': 'j', 'झ': 'jh', 'ञ': 'ny',
  'ट': 't', 'ठ': 'th', 'ड': 'd', 'ढ': 'dh', 'ण': 'n',
  'त': 't', 'थ': 'th', 'द': 'd', 'ध': 'dh', 'न': 'n',
  'प': 'p', 'फ': 'ph', 'ब': 'b', 'भ': 'bh', 'म': 'm',
  'य': 'y', 'र': 'r', 'ल': 'l', 'व': 'v',
  'श': 'sh', 'ष': 'sh', 'स': 's', 'ह': 'h',
  'क्ष': 'ksh', 'त्र': 'tr', 'ज्ञ': 'gya',
  'क़': 'q', 'ख़': 'kh', 'ग़': 'gh', 'ज़': 'z', 'ड़': 'r', 'ढ़': 'rh', 'फ़': 'f',
};

const VOWELS: Record<string, string> = {
  'अ': 'a', 'आ': 'aa', 'इ': 'i', 'ई': 'ee', 'उ': 'u', 'ऊ': 'oo', 'ऋ': 'ri',
  'ए': 'e', 'ऐ': 'ai', 'ओ': 'o', 'औ': 'au',
};

const MATRAS: Record<string, string> = {
  'ा': 'a', 'ि': 'i', 'ी': 'i', 'ु': 'u', 'ू': 'u', 'ृ': 'ri',
  'े': 'e', 'ै': 'ai', 'ो': 'o', 'ौ': 'au',
};

const MODIFIERS: Record<string, string> = {
  'ं': 'n', 'ँ': 'n', 'ः': 'h', '़': '',
};

const DIGITS: Record<string, string> = {
  '०': '0', '१': '1', '२': '2', '३': '3', '४': '4',
  '५': '5', '६': '6', '७': '7', '८': '8', '९': '9',
};

const HALANT = '्';

function transliterateDevanagariWord(word: string): string {
  const cleanW = word.replace(/[।॥]/g, '').trim();
  if (!cleanW) return '';

  if (DEV_TO_ENGLISH[cleanW]) return DEV_TO_ENGLISH[cleanW];
  if (DEV_TO_HINGLISH[cleanW]) return DEV_TO_HINGLISH[cleanW];

  const res: string[] = [];
  const chars = Array.from(cleanW);
  const n = chars.length;

  for (let i = 0; i < n; i++) {
    const c = chars[i];
    const nextC = i + 1 < n ? chars[i + 1] : null;

    if (DIGITS[c]) {
      res.push(DIGITS[c]);
    } else if (VOWELS[c]) {
      res.push(VOWELS[c]);
    } else if (CONSONANTS[c]) {
      const base = CONSONANTS[c];
      if (nextC === HALANT) {
        res.push(base);
      } else if (nextC && MATRAS[nextC]) {
        res.push(base);
      } else if (nextC && MODIFIERS[nextC] && (i + 2 >= n || !MATRAS[chars[i + 2]])) {
        res.push(base + 'a');
      } else if (nextC === null) {
        res.push(base);
      } else {
        res.push(base + 'a');
      }
    } else if (MATRAS[c]) {
      res.push(MATRAS[c]);
    } else if (MODIFIERS[c]) {
      res.push(MODIFIERS[c]);
    } else if (c === HALANT) {
      // halant suppresses vowel, handled above
    } else {
      res.push(c);
    }
  }

  return res.join('');
}

/**
 * Converts Hindi vernacular text (Devanagari script) into clean Romanized Hindi (Hinglish).
 * Preserves English characters and numbers.
 */
export function romanizeHindi(text?: string | null): string {
  if (!text) return '';
  if (!DEV_PATTERN.test(text)) return text.trim();

  // Normalize Devanagari full stop (Danda) to standard period
  const normalized = text.replace(/।/g, '.').replace(/॥/g, '.').trim();

  // Split into words and tokens preserving spacing and punctuation
  const tokens = normalized.split(/(\s+|[.,!?;:"'()]+)/);
  const output: string[] = [];

  for (const token of tokens) {
    if (!token) continue;
    if (DEV_PATTERN.test(token)) {
      output.push(transliterateDevanagariWord(token));
    } else {
      output.push(token);
    }
  }

  let result = output.join('').replace(/\s+/g, ' ').trim();
  if (result.length > 0) {
    result = result.charAt(0).toUpperCase() + result.slice(1);
  }

  return result;
}

/**
 * Processes a transcript array or JSON string, ensuring all customer turns are in Romanized Hindi.
 */
export function romanizeTranscript(transcript: any): any {
  if (!transcript) return transcript;

  let turns: any[] = [];
  let wasString = false;

  if (typeof transcript === 'string') {
    try {
      turns = JSON.parse(transcript);
      wasString = true;
    } catch {
      return transcript;
    }
  } else if (Array.isArray(transcript)) {
    turns = transcript;
  } else {
    return transcript;
  }

  const processed = turns.map((turn: any) => {
    const role = (turn.role || turn.speaker || '').toLowerCase();
    const isCustomer = role === 'customer' || role === 'user';
    const text = turn.text || turn.message || turn.content || '';

    if (isCustomer && text && DEV_PATTERN.test(text)) {
      const romanized = romanizeHindi(text);
      return {
        ...turn,
        ...(turn.text !== undefined ? { text: romanized } : {}),
        ...(turn.message !== undefined ? { message: romanized } : {}),
        ...(turn.content !== undefined ? { content: romanized } : {}),
      };
    }
    return turn;
  });

  return wasString ? JSON.stringify(processed) : processed;
}
