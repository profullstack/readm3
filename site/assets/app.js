/*
 * Two small behaviours, no dependencies.
 *
 * The theme buttons set data-theme on every reader window, which swaps the CSS
 * variables the spans are colored through. Nothing is re-rendered, because the
 * spans carry roles rather than colors. That is the same property that lets the
 * terminal reader change theme without re-parsing the document.
 */
(function () {
  "use strict";

  var STORE = "readm3:theme";

  function windows() {
    return document.querySelectorAll(".window");
  }

  function apply(name) {
    windows().forEach(function (el) {
      el.setAttribute("data-theme", name);
    });
    document.querySelectorAll("[data-set-theme]").forEach(function (button) {
      button.classList.toggle("on", button.getAttribute("data-set-theme") === name);
    });
  }

  document.querySelectorAll("[data-set-theme]").forEach(function (button) {
    button.addEventListener("click", function () {
      var name = button.getAttribute("data-set-theme");
      apply(name);
      try {
        localStorage.setItem(STORE, name);
      } catch (error) {
        /* a private window is not a reason to fail */
      }
    });
  });

  try {
    var saved = localStorage.getItem(STORE);
    if (saved && document.querySelector('[data-set-theme="' + saved + '"]')) apply(saved);
  } catch (error) {
    /* nothing stored, nothing to restore */
  }

  document.querySelectorAll("[data-copy]").forEach(function (button) {
    button.addEventListener("click", function () {
      var text = button.getAttribute("data-copy");
      var done = function () {
        var was = button.textContent;
        button.textContent = "Copied";
        setTimeout(function () {
          button.textContent = was;
        }, 1400);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, function () {});
      }
    });
  });
})();
