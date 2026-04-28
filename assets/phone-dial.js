(function (global) {
  "use strict";

  var PHONE_DIAL_OPTIONS = [
    { code: "1", label: "United States" },
    { code: "44", label: "United Kingdom" },
    { code: "49", label: "Germany" },
    { code: "33", label: "France" },
    { code: "39", label: "Italy" },
    { code: "34", label: "Spain" },
    { code: "31", label: "Netherlands" },
    { code: "32", label: "Belgium" },
    { code: "41", label: "Switzerland" },
    { code: "43", label: "Austria" },
    { code: "46", label: "Sweden" },
    { code: "47", label: "Norway" },
    { code: "45", label: "Denmark" },
    { code: "358", label: "Finland" },
    { code: "353", label: "Ireland" },
    { code: "351", label: "Portugal" },
    { code: "48", label: "Poland" },
    { code: "420", label: "Czech Republic" },
    { code: "36", label: "Hungary" },
    { code: "40", label: "Romania" },
    { code: "7", label: "Russia / Kazakhstan" },
    { code: "380", label: "Ukraine" },
    { code: "90", label: "Türkiye" },
    { code: "971", label: "United Arab Emirates" },
    { code: "966", label: "Saudi Arabia" },
    { code: "972", label: "Israel" },
    { code: "20", label: "Egypt" },
    { code: "27", label: "South Africa" },
    { code: "91", label: "India" },
    { code: "86", label: "China" },
    { code: "81", label: "Japan" },
    { code: "82", label: "South Korea" },
    { code: "65", label: "Singapore" },
    { code: "60", label: "Malaysia" },
    { code: "66", label: "Thailand" },
    { code: "84", label: "Vietnam" },
    { code: "62", label: "Indonesia" },
    { code: "61", label: "Australia" },
    { code: "64", label: "New Zealand" },
    { code: "52", label: "Mexico" },
    { code: "55", label: "Brazil" },
    { code: "54", label: "Argentina" },
    { code: "56", label: "Chile" },
    { code: "57", label: "Colombia" },
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
