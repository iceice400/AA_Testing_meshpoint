/**
 * Compose helpers: reply prefixes, @mention rendering, byte counting, autocomplete.
 */
const MessagingCompose = {
    MAX_BYTES: 228,

    byteLength(str) {
        return new TextEncoder().encode(str || '').length;
    },

    timeAgo(ts) {
        if (!ts) return '--';
        const heardMs = Date.parse(ts);
        if (Number.isNaN(heardMs)) return '--';
        const diff = Math.floor((Date.now() - heardMs) / 1000);
        if (diff < 60) return 'Now';
        if (diff < 3600) return `${Math.floor(diff / 60)}m ago`;
        if (diff < 86400) return `${Math.floor(diff / 3600)}h ago`;
        return `${Math.floor(diff / 86400)}d ago`;
    },

    formatNodeId(nodeId, protocol) {
        if (!nodeId) return '--';
        if (protocol === 'meshcore') {
            return nodeId.length > 12 ? nodeId.slice(0, 12) : nodeId;
        }
        const id = String(nodeId).replace(/^!/, '');
        return id.length > 8 ? `!${id.slice(-8)}` : `!${id}`;
    },

    buildChannelReplyPrefix(conversation, senderMeta, displayName) {
        const name = displayName
            || senderMeta?.display_name
            || senderMeta?.short_name
            || '';
        if (!name) return '@';
        if (conversation?.protocol === 'meshcore') {
            return `@[${name}] `;
        }
        const short = senderMeta?.short_name || name.split(/[\s_\-.]+/)[0] || name;
        return `@${short} `;
    },

    buildDmReplyPrefix(originalText) {
        const maxQuote = 120;
        let quote = (originalText || '').replace(/\s+/g, ' ').trim();
        if (quote.length > maxQuote) {
            quote = `${quote.slice(0, maxQuote - 1)}…`;
        }
        return `> ${quote}\n\n`;
    },

    truncateToByteLimit(text, maxBytes) {
        const enc = new TextEncoder();
        if (enc.encode(text).length <= maxBytes) return text;
        let out = '';
        for (const ch of text) {
            const next = out + ch;
            if (enc.encode(next).length > maxBytes) break;
            out = next;
        }
        return out;
    },

    /**
     * Safely render message text with highlighted @mentions.
     */
    renderMentionHtml(text, escFn) {
        const raw = text || '';
        const esc = escFn || ((s) => {
            const el = document.createElement('span');
            el.textContent = s;
            return el.innerHTML;
        });

        const parts = [];
        const re = /@\[([^\]]+)\]|@([A-Za-z0-9][\w\-]*)/g;
        let last = 0;
        let match;
        while ((match = re.exec(raw)) !== null) {
            if (match.index > last) {
                parts.push(esc(raw.slice(last, match.index)));
            }
            const label = match[1] || match[2] || '';
            parts.push(`<span class="msg-mention">${esc(match[0])}</span>`);
            last = match.index + match[0].length;
        }
        if (last < raw.length) {
            parts.push(esc(raw.slice(last)));
        }
        return parts.join('');
    },

    filterContacts(contacts, protocol, query) {
        const q = (query || '').toLowerCase();
        return (contacts || [])
            .filter((c) => !protocol || c.protocol === protocol)
            .filter((c) => {
                if (!q) return true;
                const name = (c.name || '').toLowerCase();
                const id = (c.node_id || '').toLowerCase();
                return name.includes(q) || id.includes(q);
            })
            .slice(0, 8);
    },

    insertMention(inputEl, conversation, contact) {
        if (!inputEl || !contact) return;
        const val = inputEl.value || '';
        const atIdx = val.lastIndexOf('@');
        const prefix = atIdx >= 0 ? val.slice(0, atIdx) : val;
        let mention;
        if (conversation?.protocol === 'meshcore') {
            mention = `@[${contact.name || contact.node_id}] `;
        } else {
            const short = contact.name?.split(/[\s_\-.]+/)[0] || contact.name || contact.node_id;
            mention = `@${short} `;
        }
        inputEl.value = prefix + mention;
        inputEl.focus();
        const pos = inputEl.value.length;
        inputEl.setSelectionRange(pos, pos);
    },
};

window.MessagingCompose = MessagingCompose;
