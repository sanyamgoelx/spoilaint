// Support page: copy the UPI ID.
(function () {
  'use strict';
  var btn = document.getElementById('copy');
  btn.addEventListener('click', function () {
    var id = document.getElementById('upiId').textContent;
    var done = function (ok) {
      btn.textContent = ok ? 'Copied' : 'Select it and copy';
      btn.classList.toggle('ok', ok);
      setTimeout(function () { btn.textContent = 'Copy'; btn.classList.remove('ok'); }, 1600);
    };
    if (navigator.clipboard) navigator.clipboard.writeText(id).then(function () { done(true); }, function () { done(false); });
    else done(false);
  });
})();
