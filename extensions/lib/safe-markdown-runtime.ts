// ABOUTME: Tiny dependency-free Markdown runtime used by local and standalone viewers.
// ABOUTME: It escapes all source text and permits only a small, safe link allowlist.

/**
 * Browser-side Markdown compatibility runtime. It intentionally supports a
 * conservative subset instead of executing remote parser code in an
 * authenticated local viewer. The `marked` shape keeps existing templates
 * compatible without a third-party CDN dependency.
 */
export const SAFE_MARKDOWN_RUNTIME = String.raw`
(function () {
  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function inline(value) {
    var out = escapeHtml(value);
    out = out.replace(/\[([^\]]+)\]\(((?:https?:\/\/|mailto:|#)[^)\s]+)\)/g, function (_, label, url) {
      return '<a href="' + escapeHtml(url) + '" target="_blank" rel="noopener noreferrer">' + label + '</a>';
    });
    out = out.replace(/\x60([^\x60]+)\x60/g, '<code>$1</code>');
    out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
    out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
    out = out.replace(/\*([^*]+)\*/g, '<em>$1</em>');
    return out;
  }

  function parse(markdown) {
    var lines = String(markdown == null ? '' : markdown).replace(/\r\n?/g, '\n').split('\n');
    var out = [];
    var list = null;
    var code = false;

    function closeList() {
      if (list) { out.push('</' + list + '>'); list = null; }
    }

    lines.forEach(function (line) {
      var fence = line.match(/^\s*\x60\x60\x60/);
      if (fence) {
        if (code) { out.push('</code></pre>'); code = false; }
        else { closeList(); out.push('<pre><code>'); code = true; }
        return;
      }
      if (code) { out.push(escapeHtml(line) + '\n'); return; }
      if (!line.trim()) { closeList(); return; }

      var heading = line.match(/^\s*(#{1,6})\s+(.+?)\s*#*\s*$/);
      if (heading) { closeList(); out.push('<h' + heading[1].length + '>' + inline(heading[2]) + '</h' + heading[1].length + '>'); return; }
      if (/^\s*(---+|\*\*\*+)\s*$/.test(line)) { closeList(); out.push('<hr>'); return; }

      var checkbox = line.match(/^\s*[-*+]\s+\[([ xX])\]\s*(.*)$/);
      if (checkbox) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li><input type="checkbox" disabled' + (checkbox[1].toLowerCase() === 'x' ? ' checked' : '') + '> ' + inline(checkbox[2]) + '</li>');
        return;
      }
      var bullet = line.match(/^\s*[-*+]\s+(.+)$/);
      if (bullet) {
        if (list !== 'ul') { closeList(); out.push('<ul>'); list = 'ul'; }
        out.push('<li>' + inline(bullet[1]) + '</li>');
        return;
      }
      var ordered = line.match(/^\s*\d+[.)]\s+(.+)$/);
      if (ordered) {
        if (list !== 'ol') { closeList(); out.push('<ol>'); list = 'ol'; }
        out.push('<li>' + inline(ordered[1]) + '</li>');
        return;
      }

      closeList();
      out.push('<p>' + inline(line) + '</p>');
    });

    if (code) out.push('</code></pre>');
    closeList();
    return out.join('');
  }

  window.marked = { parse: parse, setOptions: function () {} };
})();
`;