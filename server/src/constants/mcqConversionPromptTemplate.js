// mcqConversionPromptTemplate.js
//
// Constants backing the "MCQ Conversion Prompt" feature (see
// PromptState.js and promptState.service.js). Purely additive — nothing
// in the existing import/taxonomy flow reads from this file.
//
// SEED_SUBTOPIC_BANK is the one-time seed for PromptState.subtopic_bank
// (see PromptState.getOrCreate's setOnInsert) — after the singleton doc
// is first created, this constant is never consulted again; all future
// growth happens via promptState.service.js's mergeSubtopicsIntoBank.
//
// PROMPT_TEMPLATE is the full MCQ conversion prompt text, verbatim,
// except for two token substitutions filled in at read time by
// promptState.service.js's buildPromptText:
//   - {{RANGE_START}} / {{RANGE_END}} -> state.range_start / state.range_end
//   - {{SUBTOPIC_BANK_LIST}} -> state.subtopic_bank, one "- <name>" per line

export const SEED_SUBTOPIC_BANK = [
  "Earth Dimensions & Physical Features",
  "Oceans, Seas & Gulfs",
  "Continents & Landmasses",
  "Atmosphere, Climatology & Weathering",
  "Waterways, Straits & Canals",
  "Global Political Geography & Borders",
  "Deserts, Islands & Volcanoes",
  "Famous Landmarks & Cities",
  "Economic Geography & Resources",
  "Astronomy & Planetary Motions",
  "Geographical Concepts & History",
  "Problems on Ages",
  "Speed, Time & Distance",
  "Compound Interest",
  "Averages",
  "Profit & Loss",
  "Percentages",
  "Simple Interest",
  "Ratio & Proportion",
  "Constitutional Articles",
  "Regional Literature & Sufi Poets",
  "Dams, Rivers & Hydrography",
  "Mountain Passes & Border Routes",
  "Prime Ministers & Governments",
  "Treaties & Bilateral Agreements",
  "International Organizations & Alliances",
  "Constitutional History",
  "National Symbols & Emblems",
  "Administrative Divisions of Pakistan",
  "Mountains, Glaciers & Passes",
  "Highways & Infrastructure",
  "Modern Revolutions & Conflicts",
  "Global Media & News Agencies",
  "Legal & Latin Terms",
  "Global Political Figures",
  "Literary Classics & Authors",
  "Transit & Infrastructure",
  "Global Political Systems & Parliaments",
  "Global Infrastructure & Highways",
  "Ethnic Groups & Demographics",
  "Sports Trophies & Tournaments",
  "Organs of State",
  "Plant Species & Classification",
  "Data Units & Memory",
  "Renewable Energy & Materials",
  "Human Health & Nutrition",
  "Electromagnetic Waves & Tech",
  "Scientific Instruments & Measurements",
  "Chemicals in Daily Life",
  "Units of Measurement",
  "Chronology of World Events",
  "Historical Figures & Philosophers",
  "All India Muslim League History",
  "Life & Leadership of Quaid-e-Azam",
  "British Constitutional Acts",
  "Round Table Conferences",
  "Islamic Educational Movements",
  "Ghazwat & Expeditions",
  "Prophets in Islam",
  "Quranic Commandments & Injunctions",
  "Sahaba & Companions",
  "Revelation of Quran",
  "Hajj & Pilgrimage Rituals",
  "Zakat & Economic System",
  "English Vocabulary & Terms",
  "Financial Markets & Terms",
  "Urdu Language & Script",
  "International Organizations",
  "National Emblems & Symbols",
  "Transportation & Urban Transit",
  "Educational Institutions",
  "Languages & Alphabets",
  "Culture & Performing Arts",
  "Airlines & Transportation",
  "Abbreviations & Acronyms",
  "Nobel Prizes & Awards",
  "Literary Works & Authors",
  "General Facts",
  "Psychology & Phobias",
  "Founding Fathers & Leaders",
  "Human Skeleton & Physiology",
  "Instruments & Measurements",
  "Animal Anatomy & Wildlife",
  "Chemical Symbols & Elements",
  "Human Organs & Systems",
  "Chemical Compounds & Daily Science",
  "Computer Concepts & IT",
  "Units & Measurements",
  "Scientific Inventions & History",
  "Medical Fields & Health",
  "Tools & Engineering",
  "Physics Concepts & Mechanics",
  "Sports History & Terminology",
  "Sports Rules & Terminology",
  "British Colonial Policy",
  "Constitutional Developments",
  "Political Movements & Protests",
];

export const PROMPT_TEMPLATE = `# Task: Convert MCQs from the attached PDF into structured JSON

You are given a PDF containing multiple-choice questions (MCQs).

Convert from MCQ Number {{RANGE_START}} to MCQ Number {{RANGE_END}} into the JSON format specified below, in order. This is a fixed batch -- convert exactly this range, nothing more and nothing less, even if the PDF has more questions after it.

Output format -- MUST MATCH EXACTLY, NO EXTRA FIELDS

Return a JSON file with EXACTLY this shape and EXACTLY these fields -- no extra fields, no missing fields, this is imported directly into a system that will reject anything else:

\`\`\`json
{
  "questions": [
    {
      "question": "What is the capital of Pakistan?",
      "options": {
        "A": "Karachi",
        "B": "Islamabad",
        "C": "Lahore",
        "D": "Peshawar"
      },
      "correct_answer": "B",
      "subject": "Pakistan Affairs",
      "topic": "Geography",
      "subtopic": "Capitals",
      "difficulty": "easy",
      "exam_tags": ["FPSC", "PPSC", "NTS", "CSS", "PMS"],
      "cognitive_level": "recall",
      "quality_score": 80
    }
  ]
}
\`\`\`

Field notes:
- \`question\`: the question text from the PDF. You may lightly clean it up (fix OCR errors, awkward phrasing, punctuation) as long as the meaning and the fact being tested stay exactly the same.
- \`options\`: always 4 keys, \`A\`-\`D\`, matching the PDF's options (lightly cleaned up the same way if needed).
- \`correct_answer\`: one of \`A\`, \`B\`, \`C\`, \`D\`. If the PDF does not mark which option is correct, use your own knowledge to determine the correct answer yourself -- every question must have a correct_answer, never leave it blank or null.
- \`difficulty\`: one of \`easy\`, \`medium\`, \`hard\` -- your best estimate based on the question content.
- \`cognitive_level\`: one of \`recall\`, \`understanding\`, \`application\`, \`analysis\` -- your best estimate.
- \`quality_score\`: an integer 0-100, your estimate of how well-formed/clear the question is.
- \`exam_tags\`: **every single question must have exactly 5 tags**, chosen from the approved list below, picking the 5 exams most relevant to that question's subject matter.

## Hard rules -- read carefully

1. **Do not invent, rename, or reword any Subject or Topic.** Pick \`subject\` and \`topic\` ONLY from the taxonomy list below, and copy the spelling, capitalization, spacing, and punctuation (including \`&\`, parentheses, slashes) **character-for-character** as shown. Do not "clean up" or "correct" a name that looks odd to you -- copy it exactly as given.
2. Every question's \`subject\` and \`topic\` must be one of the exact (Subject, Topic) pairs listed below -- a topic only belongs under the subject it is listed under.
3. **\`exam_tags\` must only use values from the approved exam tag list below**, and every question must have exactly 5 of them. Never invent a new tag or abbreviate one differently.
4. If a question's actual subject matter doesn't cleanly match any topic in the list, pick the single closest available topic -- do not invent a new one.
5. **The JSON file itself must contain ONLY the fields shown in the format above -- nothing else.** Do not add fields like \`needs_review\`, \`notes\`, \`new_subtopics_used\`, etc. inside the JSON. (See the separate "New Subtopics" report requested below, which goes OUTSIDE the JSON.)

## Subtopic rules -- read carefully, this is where people usually go wrong

A subtopic is a broad sub-theme shared by MANY questions, not a one-line label for a single question. **Do not create a new subtopic for every question.** A topic like "Geography" under "Pakistan Affairs" should end up with a handful of subtopics used repeatedly (e.g. "Rivers", "Mountain Ranges", "Provinces & Capitals", "Borders & Neighbors") -- not 100 different one-off subtopics for 100 questions.

Follow this process for every batch:
1. **First**, reuse a subtopic from the "Existing Subtopic Bank" below if the question fits one of those entries -- copy it character-for-character, do not paraphrase it.
2. If nothing in the bank fits, reuse a subtopic you already created **earlier in this same batch** for a similar question, rather than creating a near-duplicate (e.g. don't create both "Provincial Capitals" and "Capitals of Provinces" -- pick one and reuse it).
3. Only create a genuinely new subtopic if the question truly doesn't fit anything in the bank or anything you've already used in this batch.


Existing Subtopic Bank (reuse these first -- copy exactly)

{{SUBTOPIC_BANK_LIST}}

## Approved Subjects & Topics (use these exact spellings only)

Everyday Science:
  - Agricultural Science
  - Agriculture
  - Astronomy
  - Astronomy & Physical Geography
  - Astronomy / Geography
  - Atmospheric Science
  - Biochemistry
  - Biological Sciences
  - Biology
  - Biology & Chemistry
  - Biology & Ecology
  - Biology & Medicine
  - Biology & Nutrition
  - Biotechnology
  - Botany
  - Botany & Agriculture
  - Chemistry
  - Chemistry & Geology
  - Chemistry & Medicine
  - Chemistry & Nutrition
  - Chemistry & Technology
  - Climatology
  - Computer Science
  - Dermatology
  - Earth Science
  - Ecology
  - Electronics
  - Energy Resources
  - Entomology
  - Environmental Science
  - Famous Scientists
  - Food Science
  - General Science Facts
  - Genetics
  - Geography & Agriculture
  - Geography & Climatology
  - Geology
  - Geology & Biology
  - Geology & Technology
  - Global Health
  - Global Statistics
  - Health & Disease
  - Health & Diseases
  - History of Science
  - Human Anatomy
  - Human Anatomy & Embryology
  - Human Health
  - Human Health & Diseases
  - Human Pathology
  - Human Physiology & Nutrition
  - Inventions
  - Materials Science
  - Medical Science
  - Medical Sciences
  - Medicine
  - Meteorology
  - Microbiology
  - Nutrition
  - Optics & Vision
  - Paleontology
  - Pharmacology
  - Physics
  - Physics & Applied Chemistry
  - Physics & Chemistry
  - Physics & Climatology
  - Physics & Electronics
  - Physics & Physiology
  - Physics / Astronomy
  - Physiology
  - Soil Science
  - Space Exploration
  - Technology
  - Telecommunications
  - Units & Measurements
  - Vitamins & Health
  - Zoology
  - Zoology & Biotechnology
  - Zoology & Paleontology
  - Zoology & Physics

Islamic Studies:
  - Akhlaq
  - Articles of Faith
  - Battles of Islam (Ghazwat)
  - Caliphate & Khilafat-e-Rashida
  - Companions (Sahaba)
  - Fiqh (Islamic Jurisprudence)
  - Fundamentals of Islam
  - General Islamic Information
  - Geography of Islam
  - Hadith
  - Heavenly Books
  - History of Kaaba
  - Holy Books
  - Ibadat
  - Islamic Beliefs
  - Islamic Economics
  - Islamic Governance & State System
  - Islamic History
  - Islamic Literature
  - Islamic Philosophy & Theology
  - Islamic Terminology
  - Isra and Mi'raj
  - Muslim Scientists & Scholars
  - Pakistan & Islam
  - Pillars of Islam
  - Prophets
  - Quran
  - Quranic History
  - Quranic Knowledge
  - Quranic Studies
  - Religious Reformers
  - Sacred Places
  - Sacred Relics
  - Seerah (Life of the Prophet)
  - Sufism
  - Treaties and Pacts
  - Worship in Islam

Pakistan Affairs:
  - Agriculture
  - Archaeology
  - Aviation
  - Cinema & Awards
  - Constitution
  - Culture & Heritage
  - Defense & Military
  - Demographics
  - Economy
  - Education
  - Energy Sector
  - Environment & Natural Resources
  - Foreign Policy & Relations
  - Geography
  - Geopolitics & Boundaries
  - Governance
  - Health Department
  - Historic Events & Partition
  - Historical Landmarks
  - Historiography
  - History
  - Ideology of Pakistan
  - Infrastructure
  - Kashmir Issue
  - Law & Judiciary
  - Literature
  - Media & Journalism
  - National Days
  - National Symbols
  - Natural Resources
  - Pakistan Politics
  - Pakistan Studies
  - Personalities
  - Political System
  - Science & Technology
  - Social Organizations & Welfare
  - Sports
  - Transport & Communications
  - Urban Development
  - Water Resources

English:
  - Analogy
  - Foreign Phrases
  - Grammar
  - Idioms
  - Reading Comprehension
  - Translation
  - Verbal Reasoning
  - Vocabulary
  - English literature

Geography:
  - Capitals
  - Climatology
  - Continents
  - Deserts
  - Famous Landmarks
  - Famous Places
  - Geography
  - International Borders
  - International Trade
  - Lakes & Water Bodies
  - Lakes of the World
  - Mountain Passes
  - Oceans
  - Physical Features
  - Ports and Water Bodies
  - Rivers & Confluences
  - Rivers & Dams
  - Rivers and Cities
  - Rivers and Hydrography
  - Rivers of the World
  - Straits and Channels
  - Waterfalls & Physical Features
  - World Rivers

General Knowledge:
  - Astrology
  - Aviation
  - Awards & Honors
  - Books & Authors
  - Branches of Knowledge
  - Business & Economy
  - Contemporary World
  - Culture & Arts
  - Currencies
  - Current Affairs
  - Demographics
  - Energy & Environment
  - Environment & Ecology
  - Famous Quotes
  - Financial Markets
  - Foreign Terms & Phrases
  - Geographical Achievements
  - Geographical Epithets
  - Global Health Initiatives
  - Global Initiatives
  - Important Days & Events
  - Intelligence Agencies
  - International Awards
  - Islamic World
  - Law & Legal Terms
  - Mathematics & History
  - Media & Agencies
  - Military Operations
  - National Symbols & Emblems
  - News Agencies
  - Nobel Laureates
  - Nobel Prizes
  - Numerals
  - Old Names
  - Ottoman Empire
  - Personalities & Biographies
  - Philosophy
  - Phobias
  - Public Health
  - Regional Politics & Conflicts
  - Symbols & Flags
  - Tech Leaders
  - Terminology & Abbreviations
  - Transportation
  - Units of Measurement
  - World Agriculture
  - World Capitals
  - World Economy
  - World Events
  - World Firsts
  - World Institutions & Museums
  - World Landmarks & Wonders
  - World Mythologies
  - World Parliaments
  - World Personalities
  - World Politics
  - World Records
  - World Religions
  - World Superlatives
  - World War I & II

General Abilities:
  - Analytical Reasoning
  - Logical Reasoning
  - Psychology
  - Quantitative
  - Testing & Assessment

Indo-Pak History:
  - Ancient & Medieval India
  - British Rule
  - Communal Movements
  - Delhi Sultanate
  - Freedom Movement
  - Modern History
  - Mughal Empire
  - Muslim Journalism
  - Partition
  - Political Organizations
  - Quaid-e-Azam
  - Rebellions & War of Independence 1857
  - Reform Movements

International Relations:
  - Cold War History
  - Conferences & Summits
  - Diplomacy
  - Global Defense Industry
  - Indo-Pak Relations
  - International Affairs
  - International Conferences
  - International Declarations
  - International Events
  - International Organizations
  - International Organizations & NGOs
  - International Security
  - Neighboring Countries
  - Regional Organizations
  - United Nations
  - World Leaders

Urdu:
  - Grammar
  - Idioms
  - Imla (Spelling)
  - Iqbaliyat
  - Translation
  - Urdu Adab
  - Urdu Drama
  - Urdu Poetics
  - Urdu Poetry
  - Urdu Prose
  - Urdu/Islamic Terminology
  - Vocabulary

US History:
  - 19th Century Politics
  - 20th Century Politics
  - American Civil War
  - American Revolution
  - Antebellum Economy
  - Antebellum Period
  - Civil Rights Movement
  - Civil War & Reconstruction
  - Cold War
  - Cold War Diplomacy
  - Cold War Era
  - Cold War Treaties
  - Colonial Period
  - Constitutional Amendments
  - Early America & Exploration
  - Early Exploration
  - Early Foreign Policy
  - Early Republic
  - Economic History
  - Foreign Policy
  - Geography & Diplomacy
  - Great Depression & New Deal
  - Historiography
  - Imperialism & Expansion
  - Late 20th Century Politics
  - Modern History Literature
  - Progressive Era
  - Reconstruction Era
  - Science & Technology
  - Social Reform Movements
  - Territorial Expansion
  - US Constitution
  - US Geography
  - US Geography & Union
  - US Judiciary
  - US Political System
  - War of 1812
  - Westward Expansion
  - World War II

World History:
  - American History
  - Ancient Civilizations
  - Ancient History
  - European History
  - Exploration & Voyages
  - Famous Personalities
  - Indo-Pak History
  - Modern World History
  - Regional History
  - South Asian History
  - US History
  - World History (General)
  - World War II

Sports:
  - Baseball
  - Cricket
  - Hockey
  - Olympics
  - Sports & Awards
  - Sports & Mountaineering
  - Tennis

Economics:
  - Cost Theory
  - Firm Equilibrium
  - General Economics Facts
  - Macroeconomics
  - Market Structures
  - Microeconomics
  - Pakistan Economy

Mathematics:
  - Arithmetic
  - General Math Facts
  - Geometry

Political Science:
  - Political Systems
  - Political Thought

Education:
  - Pedagogy
  - Teaching Methodology

Current Affairs:
  - Culture & Media
  - Key Appointments

## Approved Exam Tags (use these exact spellings only)

\`\`\`
FPSC, CSS, PMS, PPSC, KPPSC, SPSC, BPSC, AJKPSC, GBPSC, NTS, OTS, PTS, STS, ETEA, CTS, CTSP, UTS, ITS, BTS, GTS, HEC, USAT, LAT, GAT General, GAT Subject, Pakistan Army, PMA Long Course, PMA Graduate Course, Lady Cadet Course (LCC), Direct Short Service Commission (DSSC), AFNS, Soldier Recruitment, Clerk Recruitment, Technical Cadet Course (TCC), Pakistan Navy, PN Cadet, Sailor, Marine, SSC Navy, Pakistan Air Force (PAF), GD Pilot, Aeronautical Engineering, Air Defence, Admin & Special Duties, Aero Trades, Airman, Civilian Jobs, ASF, FIA, IB, ISI (where applicable), Punjab Police, Sindh Police, KPK Police, Balochistan Police, Islamabad Police, Traffic Police, Elite Force, Dolphin Force, CTD, ANF, NAB, Motorway Police (NHMP), Pakistan Rangers, Frontier Corps (FC), Frontier Constabulary, Pakistan Coast Guards, Prison Department, Rescue 1122, EST, SST, PST, JEST, HST, CT, PET, DM, AT, Lecturer, SBP, SBOTS, NBP, HBL, UBL, MCB, ABL, Meezan Bank, BOP, Bank Al Habib, Bank Alfalah, Askari Bank, Faysal Bank, Allied Bank, FBR, NADRA, WAPDA, NTDC, PESCO, LESCO, GEPCO, FESCO, MEPCO, QESCO, HESCO, SEPCO, SNGPL, SSGC, Pakistan Railways, Pakistan Post, Election Commission, CDA, PEMRA, OGDCL, PPL, Sui Gas, Customs, Excise & Taxation, Local Government, Revenue Department, Board of Revenue, Irrigation Department, Health Department, Livestock Department, Agriculture Department, Forest Department, ECAT, MDCAT, NUMS Entry Test, NUST Entry Test (NET), FAST Entry Test, COMSATS Entry Test, PIEAS Entry Test, GIKI Entry Test, UET Entry Test, UHS Entry Test, IBA Entry Test, LUMS Admission Test, PU Entry Test, QAU Entry Test, IIUI Entry Test, KU Entry Test, BZU Entry Test, Cadet College Entry Test
\`\`\`

## Required output structure of your reply

Reply with exactly two parts, in this order:

**Part 1 -- the JSON**, in a single \`\`\`json code block, containing ONLY the \`questions\` array as shown above. This is the part you will copy into your site -- it must be clean, valid JSON with no extra fields and no commentary mixed in.

**Part 2 -- a plain text report, OUTSIDE the code block**, titled "New Subtopics Used In This Batch", listing only the subtopics you created that were NOT already in the Existing Subtopic Bank. Format as a simple comma-separated list. This part is for you (the human) only -- it does not get uploaded anywhere, it's just so you can update the Subtopic Bank before the next batch. If no new subtopics were created, write "None -- all reused from the bank."
`;
