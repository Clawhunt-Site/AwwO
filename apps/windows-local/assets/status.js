// The shell (src/main.rs) calls window.awwoStatus with what the runtime reports: {kind: "step", step} as it starts a
// part, {kind: "message", text} for a line to show, {kind: "error", text} when it cannot start or has stopped.
(function () {
  var order = ['database', 'workers', 'api'];
  window.awwoStatus = function (update) {
    var message = document.getElementById('message');
    if (update.kind === 'step') {
      var at = order.indexOf(update.step);
      document.querySelectorAll('.steps li').forEach(function (item) {
        var index = order.indexOf(item.getAttribute('data-step'));
        item.classList.toggle('is-done', at >= 0 && index < at);
        item.classList.toggle('is-current', index === at);
      });
      message.classList.remove('is-error');
      message.textContent = '';
    } else {
      message.classList.toggle('is-error', update.kind === 'error');
      message.textContent = String(update.text || '');
    }
    // The start's steps belong to a start: an error, or a stop or restart under way, shows its line alone until the next
    // start reports a step.
    document.body.classList.toggle('is-stopped', update.kind !== 'step');
  };
  // The shell opens this page with an update in the address's fragment (main.rs show_page). A new update on the page
  // already open changes the fragment alone, which loads nothing again: it comes as a hashchange.
  function fromAddress() {
    if (location.hash.length <= 1) return;
    try { window.awwoStatus(JSON.parse(decodeURIComponent(location.hash.slice(1)))); } catch (error) { /* only the plain page */ }
  }
  window.addEventListener('hashchange', fromAddress);
  fromAddress();
})();
