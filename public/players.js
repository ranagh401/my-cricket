// MY CRICKET - player database.
//
// The names below are real international cricketers (roughly the 2022-2026
// era). They are used without any licence or endorsement, purely for a
// personal, non-commercial game. All ratings (bat / bowl, 0-100) are the
// author's own opinion of white-ball skill and are not official statistics.
//
// Fields:
//   id        lowercase ascii, unique: first initial + "_" + surname
//   country   IND | AUS | ENG | PAK | NZ | SA | SL | WI | BAN | AFG
//   role      bat | bowl | ar (all-rounder) | wk (wicketkeeper)
//   bat       batting rating        bowl      bowling rating
//   hand      batting hand R | L
//   bowlType  fast | medium | spin | null (null = does not bowl, bowl < 40)
//   spin      off | leg | left-arm | null (only set when bowlType is spin)
//
// Works as a classic <script> (window.CRICKET_PLAYERS) and in Node (require).

(function (root, factory) {
  const data = factory();
  if (typeof module !== 'undefined' && module.exports) module.exports = data; else root.CRICKET_PLAYERS = data;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';
  return [
    // ---------------------------------------------------------------- India
    { id: 'r_sharma',       name: 'Rohit Sharma',           country: 'IND', role: 'bat',  bat: 88, bowl: 22, hand: 'R', bowlType: null,     spin: null },
    { id: 'v_kohli',        name: 'Virat Kohli',            country: 'IND', role: 'bat',  bat: 92, bowl: 18, hand: 'R', bowlType: null,     spin: null },
    { id: 's_gill',         name: 'Shubman Gill',           country: 'IND', role: 'bat',  bat: 87, bowl: 12, hand: 'R', bowlType: null,     spin: null },
    { id: 's_yadav',        name: 'Suryakumar Yadav',       country: 'IND', role: 'bat',  bat: 88, bowl: 15, hand: 'R', bowlType: null,     spin: null },
    { id: 'r_pant',         name: 'Rishabh Pant',           country: 'IND', role: 'wk',   bat: 82, bowl: 8,  hand: 'L', bowlType: null,     spin: null },
    { id: 'h_pandya',       name: 'Hardik Pandya',          country: 'IND', role: 'ar',   bat: 76, bowl: 72, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'r_jadeja',       name: 'Ravindra Jadeja',        country: 'IND', role: 'ar',   bat: 68, bowl: 80, hand: 'L', bowlType: 'spin',   spin: 'left-arm' },
    { id: 'a_patel',        name: 'Axar Patel',             country: 'IND', role: 'ar',   bat: 60, bowl: 74, hand: 'L', bowlType: 'spin',   spin: 'left-arm' },
    { id: 'j_bumrah',       name: 'Jasprit Bumrah',         country: 'IND', role: 'bowl', bat: 32, bowl: 95, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'm_siraj',        name: 'Mohammed Siraj',         country: 'IND', role: 'bowl', bat: 30, bowl: 78, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'k_yadav',        name: 'Kuldeep Yadav',          country: 'IND', role: 'bowl', bat: 32, bowl: 82, hand: 'L', bowlType: 'spin',   spin: 'left-arm' },

    // ------------------------------------------------------------ Australia
    { id: 'd_warner',       name: 'David Warner',           country: 'AUS', role: 'bat',  bat: 84, bowl: 10, hand: 'L', bowlType: null,     spin: null },
    { id: 't_head',         name: 'Travis Head',            country: 'AUS', role: 'bat',  bat: 88, bowl: 34, hand: 'L', bowlType: null,     spin: null },
    { id: 's_smith',        name: 'Steve Smith',            country: 'AUS', role: 'bat',  bat: 84, bowl: 20, hand: 'R', bowlType: null,     spin: null },
    { id: 'g_maxwell',      name: 'Glenn Maxwell',          country: 'AUS', role: 'ar',   bat: 84, bowl: 64, hand: 'R', bowlType: 'spin',   spin: 'off' },
    { id: 'm_marsh',        name: 'Mitchell Marsh',         country: 'AUS', role: 'ar',   bat: 83, bowl: 62, hand: 'R', bowlType: 'medium', spin: null },
    { id: 'm_stoinis',      name: 'Marcus Stoinis',         country: 'AUS', role: 'ar',   bat: 72, bowl: 60, hand: 'R', bowlType: 'medium', spin: null },
    { id: 'a_carey',        name: 'Alex Carey',             country: 'AUS', role: 'wk',   bat: 70, bowl: 8,  hand: 'L', bowlType: null,     spin: null },
    { id: 'p_cummins',      name: 'Pat Cummins',            country: 'AUS', role: 'bowl', bat: 44, bowl: 90, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'm_starc',        name: 'Mitchell Starc',         country: 'AUS', role: 'bowl', bat: 36, bowl: 88, hand: 'L', bowlType: 'fast',   spin: null },
    { id: 'j_hazlewood',    name: 'Josh Hazlewood',         country: 'AUS', role: 'bowl', bat: 30, bowl: 86, hand: 'L', bowlType: 'fast',   spin: null },
    { id: 'a_zampa',        name: 'Adam Zampa',             country: 'AUS', role: 'bowl', bat: 30, bowl: 84, hand: 'R', bowlType: 'spin',   spin: 'leg' },

    // -------------------------------------------------------------- England
    { id: 'j_buttler',      name: 'Jos Buttler',            country: 'ENG', role: 'wk',   bat: 87, bowl: 8,  hand: 'R', bowlType: null,     spin: null },
    { id: 'j_root',         name: 'Joe Root',               country: 'ENG', role: 'bat',  bat: 86, bowl: 34, hand: 'R', bowlType: null,     spin: null },
    { id: 'h_brook',        name: 'Harry Brook',            country: 'ENG', role: 'bat',  bat: 84, bowl: 15, hand: 'R', bowlType: null,     spin: null },
    { id: 'p_salt',         name: 'Phil Salt',              country: 'ENG', role: 'bat',  bat: 80, bowl: 6,  hand: 'R', bowlType: null,     spin: null },
    { id: 'b_stokes',       name: 'Ben Stokes',             country: 'ENG', role: 'ar',   bat: 84, bowl: 68, hand: 'L', bowlType: 'fast',   spin: null },
    { id: 'l_livingstone',  name: 'Liam Livingstone',       country: 'ENG', role: 'ar',   bat: 74, bowl: 60, hand: 'R', bowlType: 'spin',   spin: 'leg' },
    { id: 'm_ali',          name: 'Moeen Ali',              country: 'ENG', role: 'ar',   bat: 66, bowl: 66, hand: 'L', bowlType: 'spin',   spin: 'off' },
    { id: 's_curran',       name: 'Sam Curran',             country: 'ENG', role: 'ar',   bat: 62, bowl: 66, hand: 'L', bowlType: 'medium', spin: null },
    { id: 'j_archer',       name: 'Jofra Archer',           country: 'ENG', role: 'bowl', bat: 36, bowl: 86, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'a_rashid',       name: 'Adil Rashid',            country: 'ENG', role: 'bowl', bat: 32, bowl: 85, hand: 'R', bowlType: 'spin',   spin: 'leg' },
    { id: 'm_wood',         name: 'Mark Wood',              country: 'ENG', role: 'bowl', bat: 30, bowl: 80, hand: 'R', bowlType: 'fast',   spin: null },

    // ------------------------------------------------------------- Pakistan
    { id: 'b_azam',         name: 'Babar Azam',             country: 'PAK', role: 'bat',  bat: 90, bowl: 12, hand: 'R', bowlType: null,     spin: null },
    { id: 'm_rizwan',       name: 'Mohammad Rizwan',        country: 'PAK', role: 'wk',   bat: 83, bowl: 8,  hand: 'R', bowlType: null,     spin: null },
    { id: 'f_zaman',        name: 'Fakhar Zaman',           country: 'PAK', role: 'bat',  bat: 80, bowl: 20, hand: 'L', bowlType: null,     spin: null },
    { id: 's_ayub',         name: 'Saim Ayub',              country: 'PAK', role: 'bat',  bat: 70, bowl: 34, hand: 'L', bowlType: null,     spin: null },
    { id: 's_agha',         name: 'Salman Ali Agha',        country: 'PAK', role: 'ar',   bat: 66, bowl: 58, hand: 'R', bowlType: 'spin',   spin: 'off' },
    { id: 's_khan',         name: 'Shadab Khan',            country: 'PAK', role: 'ar',   bat: 60, bowl: 70, hand: 'R', bowlType: 'spin',   spin: 'leg' },
    { id: 'm_nawaz',        name: 'Mohammad Nawaz',         country: 'PAK', role: 'ar',   bat: 56, bowl: 66, hand: 'L', bowlType: 'spin',   spin: 'left-arm' },
    { id: 's_afridi',       name: 'Shaheen Shah Afridi',    country: 'PAK', role: 'bowl', bat: 38, bowl: 87, hand: 'L', bowlType: 'fast',   spin: null },
    { id: 'h_rauf',         name: 'Haris Rauf',             country: 'PAK', role: 'bowl', bat: 30, bowl: 81, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'n_shah',         name: 'Naseem Shah',            country: 'PAK', role: 'bowl', bat: 34, bowl: 80, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'a_ahmed',        name: 'Abrar Ahmed',            country: 'PAK', role: 'bowl', bat: 30, bowl: 70, hand: 'R', bowlType: 'spin',   spin: 'leg' },

    // ---------------------------------------------------------- New Zealand
    { id: 'k_williamson',   name: 'Kane Williamson',        country: 'NZ',  role: 'bat',  bat: 87, bowl: 20, hand: 'R', bowlType: null,     spin: null },
    { id: 'd_conway',       name: 'Devon Conway',           country: 'NZ',  role: 'bat',  bat: 80, bowl: 6,  hand: 'L', bowlType: null,     spin: null },
    { id: 't_latham',       name: 'Tom Latham',             country: 'NZ',  role: 'wk',   bat: 76, bowl: 6,  hand: 'L', bowlType: null,     spin: null },
    { id: 'd_mitchell',     name: 'Daryl Mitchell',         country: 'NZ',  role: 'ar',   bat: 82, bowl: 58, hand: 'R', bowlType: 'medium', spin: null },
    { id: 'g_phillips',     name: 'Glenn Phillips',         country: 'NZ',  role: 'ar',   bat: 76, bowl: 60, hand: 'R', bowlType: 'spin',   spin: 'off' },
    { id: 'r_ravindra',     name: 'Rachin Ravindra',        country: 'NZ',  role: 'ar',   bat: 80, bowl: 58, hand: 'L', bowlType: 'spin',   spin: 'left-arm' },
    { id: 'm_santner',      name: 'Mitchell Santner',       country: 'NZ',  role: 'ar',   bat: 56, bowl: 76, hand: 'L', bowlType: 'spin',   spin: 'left-arm' },
    { id: 't_boult',        name: 'Trent Boult',            country: 'NZ',  role: 'bowl', bat: 34, bowl: 86, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'm_henry',        name: 'Matt Henry',             country: 'NZ',  role: 'bowl', bat: 34, bowl: 80, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'l_ferguson',     name: 'Lockie Ferguson',        country: 'NZ',  role: 'bowl', bat: 30, bowl: 78, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'i_sodhi',        name: 'Ish Sodhi',              country: 'NZ',  role: 'bowl', bat: 34, bowl: 68, hand: 'R', bowlType: 'spin',   spin: 'leg' },

    // --------------------------------------------------------- South Africa
    { id: 'q_dekock',       name: 'Quinton de Kock',        country: 'SA',  role: 'wk',   bat: 85, bowl: 6,  hand: 'L', bowlType: null,     spin: null },
    { id: 'h_klaasen',      name: 'Heinrich Klaasen',       country: 'SA',  role: 'wk',   bat: 88, bowl: 6,  hand: 'R', bowlType: null,     spin: null },
    { id: 't_bavuma',       name: 'Temba Bavuma',           country: 'SA',  role: 'bat',  bat: 72, bowl: 10, hand: 'R', bowlType: null,     spin: null },
    { id: 'd_miller',       name: 'David Miller',           country: 'SA',  role: 'bat',  bat: 82, bowl: 10, hand: 'L', bowlType: null,     spin: null },
    { id: 'r_vanderdussen', name: 'Rassie van der Dussen',  country: 'SA',  role: 'bat',  bat: 78, bowl: 14, hand: 'R', bowlType: null,     spin: null },
    { id: 'a_markram',      name: 'Aiden Markram',          country: 'SA',  role: 'ar',   bat: 80, bowl: 55, hand: 'R', bowlType: 'spin',   spin: 'off' },
    { id: 'm_jansen',       name: 'Marco Jansen',           country: 'SA',  role: 'ar',   bat: 58, bowl: 78, hand: 'L', bowlType: 'fast',   spin: null },
    { id: 'k_rabada',       name: 'Kagiso Rabada',          country: 'SA',  role: 'bowl', bat: 36, bowl: 88, hand: 'L', bowlType: 'fast',   spin: null },
    { id: 'a_nortje',       name: 'Anrich Nortje',          country: 'SA',  role: 'bowl', bat: 30, bowl: 80, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'k_maharaj',      name: 'Keshav Maharaj',         country: 'SA',  role: 'bowl', bat: 38, bowl: 80, hand: 'R', bowlType: 'spin',   spin: 'left-arm' },
    { id: 't_shamsi',       name: 'Tabraiz Shamsi',         country: 'SA',  role: 'bowl', bat: 30, bowl: 74, hand: 'R', bowlType: 'spin',   spin: 'left-arm' },

    // ------------------------------------------------------------ Sri Lanka
    { id: 'k_mendis',       name: 'Kusal Mendis',           country: 'SL',  role: 'wk',   bat: 80, bowl: 6,  hand: 'R', bowlType: null,     spin: null },
    { id: 'p_nissanka',     name: 'Pathum Nissanka',        country: 'SL',  role: 'bat',  bat: 82, bowl: 8,  hand: 'R', bowlType: null,     spin: null },
    { id: 'c_asalanka',     name: 'Charith Asalanka',       country: 'SL',  role: 'bat',  bat: 78, bowl: 34, hand: 'L', bowlType: null,     spin: null },
    { id: 'k_perera',       name: 'Kusal Perera',           country: 'SL',  role: 'bat',  bat: 74, bowl: 6,  hand: 'L', bowlType: null,     spin: null },
    { id: 'd_desilva',      name: 'Dhananjaya de Silva',    country: 'SL',  role: 'ar',   bat: 70, bowl: 60, hand: 'R', bowlType: 'spin',   spin: 'off' },
    { id: 'd_shanaka',      name: 'Dasun Shanaka',          country: 'SL',  role: 'ar',   bat: 64, bowl: 56, hand: 'R', bowlType: 'medium', spin: null },
    { id: 'w_hasaranga',    name: 'Wanindu Hasaranga',      country: 'SL',  role: 'ar',   bat: 58, bowl: 86, hand: 'R', bowlType: 'spin',   spin: 'leg' },
    { id: 'd_wellalage',    name: 'Dunith Wellalage',       country: 'SL',  role: 'ar',   bat: 55, bowl: 66, hand: 'L', bowlType: 'spin',   spin: 'left-arm' },
    { id: 'm_theekshana',   name: 'Maheesh Theekshana',     country: 'SL',  role: 'bowl', bat: 30, bowl: 78, hand: 'R', bowlType: 'spin',   spin: 'off' },
    { id: 'm_pathirana',    name: 'Matheesha Pathirana',    country: 'SL',  role: 'bowl', bat: 30, bowl: 76, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'd_madushanka',   name: 'Dilshan Madushanka',     country: 'SL',  role: 'bowl', bat: 30, bowl: 72, hand: 'R', bowlType: 'fast',   spin: null },

    // ---------------------------------------------------------- West Indies
    { id: 'n_pooran',       name: 'Nicholas Pooran',        country: 'WI',  role: 'wk',   bat: 86, bowl: 6,  hand: 'L', bowlType: null,     spin: null },
    { id: 's_hope',         name: 'Shai Hope',              country: 'WI',  role: 'wk',   bat: 82, bowl: 6,  hand: 'R', bowlType: null,     spin: null },
    { id: 's_hetmyer',      name: 'Shimron Hetmyer',        country: 'WI',  role: 'bat',  bat: 74, bowl: 6,  hand: 'L', bowlType: null,     spin: null },
    { id: 'r_powell',       name: 'Rovman Powell',          country: 'WI',  role: 'bat',  bat: 74, bowl: 30, hand: 'R', bowlType: null,     spin: null },
    { id: 'a_russell',      name: 'Andre Russell',          country: 'WI',  role: 'ar',   bat: 76, bowl: 70, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'j_holder',       name: 'Jason Holder',           country: 'WI',  role: 'ar',   bat: 58, bowl: 72, hand: 'R', bowlType: 'medium', spin: null },
    { id: 'r_shepherd',     name: 'Romario Shepherd',       country: 'WI',  role: 'ar',   bat: 60, bowl: 64, hand: 'R', bowlType: 'medium', spin: null },
    { id: 'r_chase',        name: 'Roston Chase',           country: 'WI',  role: 'ar',   bat: 62, bowl: 60, hand: 'R', bowlType: 'spin',   spin: 'off' },
    { id: 'a_joseph',       name: 'Alzarri Joseph',         country: 'WI',  role: 'bowl', bat: 36, bowl: 80, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'a_hosein',       name: 'Akeal Hosein',           country: 'WI',  role: 'bowl', bat: 40, bowl: 76, hand: 'L', bowlType: 'spin',   spin: 'left-arm' },
    { id: 'g_motie',        name: 'Gudakesh Motie',         country: 'WI',  role: 'bowl', bat: 38, bowl: 72, hand: 'L', bowlType: 'spin',   spin: 'left-arm' },

    // ----------------------------------------------------------- Bangladesh
    { id: 'l_das',          name: 'Litton Das',             country: 'BAN', role: 'wk',   bat: 76, bowl: 6,  hand: 'R', bowlType: null,     spin: null },
    { id: 'm_rahim',        name: 'Mushfiqur Rahim',        country: 'BAN', role: 'wk',   bat: 74, bowl: 6,  hand: 'R', bowlType: null,     spin: null },
    { id: 'n_shanto',       name: 'Najmul Hossain Shanto',  country: 'BAN', role: 'bat',  bat: 72, bowl: 10, hand: 'L', bowlType: null,     spin: null },
    { id: 't_hridoy',       name: 'Towhid Hridoy',          country: 'BAN', role: 'bat',  bat: 70, bowl: 10, hand: 'R', bowlType: null,     spin: null },
    { id: 'm_mahmudullah',  name: 'Mahmudullah',            country: 'BAN', role: 'bat',  bat: 70, bowl: 34, hand: 'R', bowlType: null,     spin: null },
    { id: 's_alhasan',      name: 'Shakib Al Hasan',        country: 'BAN', role: 'ar',   bat: 72, bowl: 80, hand: 'L', bowlType: 'spin',   spin: 'left-arm' },
    { id: 'm_miraz',        name: 'Mehidy Hasan Miraz',     country: 'BAN', role: 'ar',   bat: 62, bowl: 74, hand: 'R', bowlType: 'spin',   spin: 'off' },
    { id: 'm_rahman',       name: 'Mustafizur Rahman',      country: 'BAN', role: 'bowl', bat: 30, bowl: 80, hand: 'L', bowlType: 'fast',   spin: null },
    { id: 't_ahmed',        name: 'Taskin Ahmed',           country: 'BAN', role: 'bowl', bat: 34, bowl: 76, hand: 'L', bowlType: 'fast',   spin: null },
    { id: 't_sakib',        name: 'Tanzim Hasan Sakib',     country: 'BAN', role: 'bowl', bat: 34, bowl: 66, hand: 'R', bowlType: 'medium', spin: null },
    { id: 'r_hossain',      name: 'Rishad Hossain',         country: 'BAN', role: 'bowl', bat: 40, bowl: 68, hand: 'R', bowlType: 'spin',   spin: 'leg' },

    // ---------------------------------------------------------- Afghanistan
    { id: 'r_gurbaz',       name: 'Rahmanullah Gurbaz',     country: 'AFG', role: 'wk',   bat: 80, bowl: 6,  hand: 'R', bowlType: null,     spin: null },
    { id: 'i_zadran',       name: 'Ibrahim Zadran',         country: 'AFG', role: 'bat',  bat: 82, bowl: 8,  hand: 'R', bowlType: null,     spin: null },
    { id: 'r_shah',         name: 'Rahmat Shah',            country: 'AFG', role: 'bat',  bat: 70, bowl: 30, hand: 'R', bowlType: null,     spin: null },
    { id: 'h_shahidi',      name: 'Hashmatullah Shahidi',   country: 'AFG', role: 'bat',  bat: 68, bowl: 8,  hand: 'L', bowlType: null,     spin: null },
    { id: 'm_nabi',         name: 'Mohammad Nabi',          country: 'AFG', role: 'ar',   bat: 64, bowl: 70, hand: 'R', bowlType: 'spin',   spin: 'off' },
    { id: 'a_omarzai',      name: 'Azmatullah Omarzai',     country: 'AFG', role: 'ar',   bat: 68, bowl: 68, hand: 'R', bowlType: 'medium', spin: null },
    { id: 'r_khan',         name: 'Rashid Khan',            country: 'AFG', role: 'bowl', bat: 45, bowl: 91, hand: 'R', bowlType: 'spin',   spin: 'leg' },
    { id: 'm_urrahman',     name: 'Mujeeb Ur Rahman',       country: 'AFG', role: 'bowl', bat: 30, bowl: 76, hand: 'R', bowlType: 'spin',   spin: 'off' },
    { id: 'n_ahmad',        name: 'Noor Ahmad',             country: 'AFG', role: 'bowl', bat: 30, bowl: 78, hand: 'R', bowlType: 'spin',   spin: 'left-arm' },
    { id: 'f_farooqi',      name: 'Fazalhaq Farooqi',       country: 'AFG', role: 'bowl', bat: 30, bowl: 78, hand: 'R', bowlType: 'fast',   spin: null },
    { id: 'n_ulhaq',        name: 'Naveen-ul-Haq',          country: 'AFG', role: 'bowl', bat: 32, bowl: 72, hand: 'R', bowlType: 'medium', spin: null }
  ];
});
