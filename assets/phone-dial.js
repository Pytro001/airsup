(function (global) {
  "use strict";
  var PHONE_DIAL_OPTIONS = [
  {
    "code": "93",
    "label": "Afghanistan"
  },
  {
    "code": "358",
    "label": "Aland Islands · Finland"
  },
  {
    "code": "355",
    "label": "Albania"
  },
  {
    "code": "213",
    "label": "Algeria"
  },
  {
    "code": "1",
    "label": "American Samoa · Anguilla · Antigua and Barbuda · Barbados · Bermuda · Canada · Cayman Islands · Dominica · Dominican…"
  },
  {
    "code": "376",
    "label": "Andorra"
  },
  {
    "code": "244",
    "label": "Angola"
  },
  {
    "code": "672",
    "label": "Antarctica · Heard Island and McDonald Islands · Norfolk Island"
  },
  {
    "code": "54",
    "label": "Argentina"
  },
  {
    "code": "374",
    "label": "Armenia"
  },
  {
    "code": "297",
    "label": "Aruba"
  },
  {
    "code": "61",
    "label": "Australia · Christmas Island · Cocos (Keeling) Islands"
  },
  {
    "code": "43",
    "label": "Austria"
  },
  {
    "code": "994",
    "label": "Azerbaijan"
  },
  {
    "code": "973",
    "label": "Bahrain"
  },
  {
    "code": "880",
    "label": "Bangladesh"
  },
  {
    "code": "375",
    "label": "Belarus"
  },
  {
    "code": "32",
    "label": "Belgium"
  },
  {
    "code": "501",
    "label": "Belize"
  },
  {
    "code": "229",
    "label": "Benin"
  },
  {
    "code": "975",
    "label": "Bhutan"
  },
  {
    "code": "591",
    "label": "Bolivia"
  },
  {
    "code": "599",
    "label": "Bonaire, Sint Eustatius and Saba · Curaçao"
  },
  {
    "code": "387",
    "label": "Bosnia and Herzegovina"
  },
  {
    "code": "267",
    "label": "Botswana"
  },
  {
    "code": "55",
    "label": "Brazil"
  },
  {
    "code": "246",
    "label": "British Indian Ocean Territory"
  },
  {
    "code": "673",
    "label": "Brunei"
  },
  {
    "code": "359",
    "label": "Bulgaria"
  },
  {
    "code": "226",
    "label": "Burkina Faso"
  },
  {
    "code": "257",
    "label": "Burundi"
  },
  {
    "code": "855",
    "label": "Cambodia"
  },
  {
    "code": "237",
    "label": "Cameroon"
  },
  {
    "code": "238",
    "label": "Cape Verde"
  },
  {
    "code": "236",
    "label": "Central African Republic"
  },
  {
    "code": "235",
    "label": "Chad"
  },
  {
    "code": "56",
    "label": "Chile"
  },
  {
    "code": "86",
    "label": "China"
  },
  {
    "code": "57",
    "label": "Colombia"
  },
  {
    "code": "269",
    "label": "Comoros"
  },
  {
    "code": "242",
    "label": "Congo"
  },
  {
    "code": "682",
    "label": "Cook Islands"
  },
  {
    "code": "506",
    "label": "Costa Rica"
  },
  {
    "code": "385",
    "label": "Croatia"
  },
  {
    "code": "53",
    "label": "Cuba"
  },
  {
    "code": "357",
    "label": "Cyprus"
  },
  {
    "code": "420",
    "label": "Czech Republic"
  },
  {
    "code": "243",
    "label": "Democratic Republic of the Congo"
  },
  {
    "code": "45",
    "label": "Denmark"
  },
  {
    "code": "253",
    "label": "Djibouti"
  },
  {
    "code": "593",
    "label": "Ecuador"
  },
  {
    "code": "20",
    "label": "Egypt"
  },
  {
    "code": "503",
    "label": "El Salvador"
  },
  {
    "code": "240",
    "label": "Equatorial Guinea"
  },
  {
    "code": "291",
    "label": "Eritrea"
  },
  {
    "code": "372",
    "label": "Estonia"
  },
  {
    "code": "268",
    "label": "Eswatini"
  },
  {
    "code": "251",
    "label": "Ethiopia"
  },
  {
    "code": "500",
    "label": "Falkland Islands · South Georgia"
  },
  {
    "code": "298",
    "label": "Faroe Islands"
  },
  {
    "code": "679",
    "label": "Fiji Islands"
  },
  {
    "code": "33",
    "label": "France"
  },
  {
    "code": "594",
    "label": "French Guiana"
  },
  {
    "code": "689",
    "label": "French Polynesia"
  },
  {
    "code": "262",
    "label": "French Southern Territories · Mayotte · Reunion"
  },
  {
    "code": "241",
    "label": "Gabon"
  },
  {
    "code": "995",
    "label": "Georgia"
  },
  {
    "code": "49",
    "label": "Germany"
  },
  {
    "code": "233",
    "label": "Ghana"
  },
  {
    "code": "350",
    "label": "Gibraltar"
  },
  {
    "code": "30",
    "label": "Greece"
  },
  {
    "code": "299",
    "label": "Greenland"
  },
  {
    "code": "590",
    "label": "Guadeloupe · Saint-Barthelemy · Saint-Martin (French part)"
  },
  {
    "code": "502",
    "label": "Guatemala"
  },
  {
    "code": "44",
    "label": "Guernsey · Jersey · Man (Isle of) · United Kingdom"
  },
  {
    "code": "224",
    "label": "Guinea"
  },
  {
    "code": "245",
    "label": "Guinea-Bissau"
  },
  {
    "code": "592",
    "label": "Guyana"
  },
  {
    "code": "509",
    "label": "Haiti"
  },
  {
    "code": "504",
    "label": "Honduras"
  },
  {
    "code": "852",
    "label": "Hong Kong S.A.R."
  },
  {
    "code": "36",
    "label": "Hungary"
  },
  {
    "code": "354",
    "label": "Iceland"
  },
  {
    "code": "91",
    "label": "India"
  },
  {
    "code": "62",
    "label": "Indonesia"
  },
  {
    "code": "98",
    "label": "Iran"
  },
  {
    "code": "964",
    "label": "Iraq"
  },
  {
    "code": "353",
    "label": "Ireland"
  },
  {
    "code": "972",
    "label": "Israel"
  },
  {
    "code": "39",
    "label": "Italy"
  },
  {
    "code": "225",
    "label": "Ivory Coast"
  },
  {
    "code": "81",
    "label": "Japan"
  },
  {
    "code": "962",
    "label": "Jordan"
  },
  {
    "code": "7",
    "label": "Kazakhstan · Russia"
  },
  {
    "code": "254",
    "label": "Kenya"
  },
  {
    "code": "686",
    "label": "Kiribati"
  },
  {
    "code": "383",
    "label": "Kosovo"
  },
  {
    "code": "965",
    "label": "Kuwait"
  },
  {
    "code": "996",
    "label": "Kyrgyzstan"
  },
  {
    "code": "856",
    "label": "Laos"
  },
  {
    "code": "371",
    "label": "Latvia"
  },
  {
    "code": "961",
    "label": "Lebanon"
  },
  {
    "code": "266",
    "label": "Lesotho"
  },
  {
    "code": "231",
    "label": "Liberia"
  },
  {
    "code": "218",
    "label": "Libya"
  },
  {
    "code": "423",
    "label": "Liechtenstein"
  },
  {
    "code": "370",
    "label": "Lithuania"
  },
  {
    "code": "352",
    "label": "Luxembourg"
  },
  {
    "code": "853",
    "label": "Macau S.A.R."
  },
  {
    "code": "261",
    "label": "Madagascar"
  },
  {
    "code": "265",
    "label": "Malawi"
  },
  {
    "code": "60",
    "label": "Malaysia"
  },
  {
    "code": "960",
    "label": "Maldives"
  },
  {
    "code": "223",
    "label": "Mali"
  },
  {
    "code": "356",
    "label": "Malta"
  },
  {
    "code": "692",
    "label": "Marshall Islands"
  },
  {
    "code": "596",
    "label": "Martinique"
  },
  {
    "code": "222",
    "label": "Mauritania"
  },
  {
    "code": "230",
    "label": "Mauritius"
  },
  {
    "code": "52",
    "label": "Mexico"
  },
  {
    "code": "691",
    "label": "Micronesia"
  },
  {
    "code": "373",
    "label": "Moldova"
  },
  {
    "code": "377",
    "label": "Monaco"
  },
  {
    "code": "976",
    "label": "Mongolia"
  },
  {
    "code": "382",
    "label": "Montenegro"
  },
  {
    "code": "212",
    "label": "Morocco · Western Sahara"
  },
  {
    "code": "258",
    "label": "Mozambique"
  },
  {
    "code": "95",
    "label": "Myanmar"
  },
  {
    "code": "264",
    "label": "Namibia"
  },
  {
    "code": "674",
    "label": "Nauru"
  },
  {
    "code": "977",
    "label": "Nepal"
  },
  {
    "code": "31",
    "label": "Netherlands"
  },
  {
    "code": "687",
    "label": "New Caledonia"
  },
  {
    "code": "64",
    "label": "New Zealand"
  },
  {
    "code": "505",
    "label": "Nicaragua"
  },
  {
    "code": "227",
    "label": "Niger"
  },
  {
    "code": "234",
    "label": "Nigeria"
  },
  {
    "code": "683",
    "label": "Niue"
  },
  {
    "code": "850",
    "label": "North Korea"
  },
  {
    "code": "389",
    "label": "North Macedonia"
  },
  {
    "code": "47",
    "label": "Norway · Svalbard and Jan Mayen Islands"
  },
  {
    "code": "968",
    "label": "Oman"
  },
  {
    "code": "92",
    "label": "Pakistan"
  },
  {
    "code": "680",
    "label": "Palau"
  },
  {
    "code": "970",
    "label": "Palestinian Territory Occupied"
  },
  {
    "code": "507",
    "label": "Panama"
  },
  {
    "code": "675",
    "label": "Papua New Guinea"
  },
  {
    "code": "595",
    "label": "Paraguay"
  },
  {
    "code": "51",
    "label": "Peru"
  },
  {
    "code": "63",
    "label": "Philippines"
  },
  {
    "code": "870",
    "label": "Pitcairn Island"
  },
  {
    "code": "48",
    "label": "Poland"
  },
  {
    "code": "351",
    "label": "Portugal"
  },
  {
    "code": "974",
    "label": "Qatar"
  },
  {
    "code": "40",
    "label": "Romania"
  },
  {
    "code": "250",
    "label": "Rwanda"
  },
  {
    "code": "290",
    "label": "Saint Helena"
  },
  {
    "code": "508",
    "label": "Saint Pierre and Miquelon"
  },
  {
    "code": "685",
    "label": "Samoa"
  },
  {
    "code": "378",
    "label": "San Marino"
  },
  {
    "code": "239",
    "label": "Sao Tome and Principe"
  },
  {
    "code": "966",
    "label": "Saudi Arabia"
  },
  {
    "code": "221",
    "label": "Senegal"
  },
  {
    "code": "381",
    "label": "Serbia"
  },
  {
    "code": "248",
    "label": "Seychelles"
  },
  {
    "code": "232",
    "label": "Sierra Leone"
  },
  {
    "code": "65",
    "label": "Singapore"
  },
  {
    "code": "1721",
    "label": "Sint Maarten (Dutch part)"
  },
  {
    "code": "421",
    "label": "Slovakia"
  },
  {
    "code": "386",
    "label": "Slovenia"
  },
  {
    "code": "677",
    "label": "Solomon Islands"
  },
  {
    "code": "252",
    "label": "Somalia"
  },
  {
    "code": "27",
    "label": "South Africa"
  },
  {
    "code": "82",
    "label": "South Korea"
  },
  {
    "code": "211",
    "label": "South Sudan"
  },
  {
    "code": "34",
    "label": "Spain"
  },
  {
    "code": "94",
    "label": "Sri Lanka"
  },
  {
    "code": "249",
    "label": "Sudan"
  },
  {
    "code": "597",
    "label": "Suriname"
  },
  {
    "code": "46",
    "label": "Sweden"
  },
  {
    "code": "41",
    "label": "Switzerland"
  },
  {
    "code": "963",
    "label": "Syria"
  },
  {
    "code": "886",
    "label": "Taiwan"
  },
  {
    "code": "992",
    "label": "Tajikistan"
  },
  {
    "code": "255",
    "label": "Tanzania"
  },
  {
    "code": "66",
    "label": "Thailand"
  },
  {
    "code": "220",
    "label": "The Gambia"
  },
  {
    "code": "670",
    "label": "Timor-Leste"
  },
  {
    "code": "228",
    "label": "Togo"
  },
  {
    "code": "690",
    "label": "Tokelau"
  },
  {
    "code": "676",
    "label": "Tonga"
  },
  {
    "code": "216",
    "label": "Tunisia"
  },
  {
    "code": "90",
    "label": "Turkey"
  },
  {
    "code": "993",
    "label": "Turkmenistan"
  },
  {
    "code": "688",
    "label": "Tuvalu"
  },
  {
    "code": "256",
    "label": "Uganda"
  },
  {
    "code": "380",
    "label": "Ukraine"
  },
  {
    "code": "971",
    "label": "United Arab Emirates"
  },
  {
    "code": "598",
    "label": "Uruguay"
  },
  {
    "code": "998",
    "label": "Uzbekistan"
  },
  {
    "code": "678",
    "label": "Vanuatu"
  },
  {
    "code": "379",
    "label": "Vatican City State (Holy See)"
  },
  {
    "code": "58",
    "label": "Venezuela"
  },
  {
    "code": "84",
    "label": "Vietnam"
  },
  {
    "code": "681",
    "label": "Wallis and Futuna Islands"
  },
  {
    "code": "967",
    "label": "Yemen"
  },
  {
    "code": "260",
    "label": "Zambia"
  },
  {
    "code": "263",
    "label": "Zimbabwe"
  }
];

  function sortedByCodeLengthDesc() {
    return PHONE_DIAL_OPTIONS.slice().sort(function (a, b) {
      return b.code.length - a.code.length;
    });
  }

  function digitsOnly(s) {
    return String(s == null ? "" : s).replace(/\D/g, "");
  }

  function escapeAttr(s) {
    return String(s).replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  function escapeHtml(s) {
    return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  /** @returns {{ dial: string, national: string }} dial digits only, no + */
  function parseStoredPhoneToParts(stored) {
    var raw = String(stored == null ? "" : stored).trim();
    if (!raw) return { dial: "49", national: "" };
    var allDigits = digitsOnly(raw.charAt(0) === "+" ? raw.slice(1) : raw);
    if (!allDigits) return { dial: "49", national: "" };
    var opts = sortedByCodeLengthDesc();
    for (var i = 0; i < opts.length; i++) {
      var c = opts[i].code;
      if (allDigits.indexOf(c) === 0 && allDigits.length > c.length) {
        return { dial: c, national: allDigits.slice(c.length) };
      }
    }
    return { dial: "49", national: allDigits };
  }

  function mergeDialAndNational(dial, nationalRaw) {
    var d = digitsOnly(dial);
    var n = digitsOnly(nationalRaw);
    if (!d || !n) return "";
    // User pasted full international number into the local field (e.g. 49... with DE +49)
    var guard = 0;
    while (guard < 3 && n.length > d.length && n.indexOf(d) === 0) {
      n = n.slice(d.length);
      guard++;
    }
    if (!n) return "";
    return "+" + d + n;
  }

  function dialCodeOptionsHtml(selectedDial) {
    var sel = digitsOnly(selectedDial) || "49";
    var html = "";
    for (var i = 0; i < PHONE_DIAL_OPTIONS.length; i++) {
      var opt = PHONE_DIAL_OPTIONS[i];
      var c = opt.code;
      var selected = c === sel ? " selected" : "";
      html +=
        "<option value=\"" +
        escapeAttr(c) +
        "\"" +
        selected +
        ">+" +
        escapeHtml(c) +
        " — " +
        escapeHtml(opt.label) +
        "</option>";
    }
    return html;
  }

  function wirePhoneLocalInput(inputEl) {
    if (!inputEl) return;
    inputEl.addEventListener("input", function () {
      var cur = digitsOnly(inputEl.value);
      if (inputEl.value !== cur) inputEl.value = cur;
    });
  }

  global.AIRSUP_PHONE = {
    PHONE_DIAL_OPTIONS: PHONE_DIAL_OPTIONS,
    digitsOnly: digitsOnly,
    parseStoredPhoneToParts: parseStoredPhoneToParts,
    mergeDialAndNational: mergeDialAndNational,
    dialCodeOptionsHtml: dialCodeOptionsHtml,
    wirePhoneLocalInput: wirePhoneLocalInput,
  };
})(typeof window !== "undefined" ? window : globalThis);
