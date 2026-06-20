/**
 * Chat view renderer for interleaved sent/received messages.
 * Handles bubbles, sender popover, reply compose, and lazy-loading.
 */
class MessagingChat {
    constructor(containerEl, options = {}) {
        this._container = containerEl;
        this._onSend = options.onSend || (() => {});
        this._onOpenNode = options.onOpenNode || null;
        this._onOpenDm = options.onOpenDm || null;
        this._onViewOnMap = options.onViewOnMap || null;
        this._conversation = null;
        this._messages = [];
        this._loading = false;
        this._allLoaded = false;
        this._lastDayKey = null;
        this._replyContext = null;
        this._contactsCache = null;
        this._contactsLoading = false;
        this._wantAck = false;
        this._activePopover = null;
        this._autocompleteIdx = -1;
        this._compose = window.MessagingCompose;
        this._build();
    }

    getWantAck() {
        return this._wantAck;
    }

    clearChat() {
        this._conversation = null;
        this._messages = [];
        this._allLoaded = false;
        this._replyContext = null;
        this._hidePopover();
        this._hideAutocomplete();
        this._renderReplyPreview();
        this._updateByteCounter();
        this._renderEmptyState();
        this._headerName.textContent = '';
        this._headerSubtitle.textContent = '';
        this._headerBadge.textContent = '';
        this._headerAvatar.textContent = '';
        this._headerAvatar.className = 'msg-chat__avatar';
        this._container.classList.add('msg-chat--empty');
        this._input.disabled = true;
        this._sendBtn.disabled = true;
        if (this._input) this._input.value = '';
        this._updateWantAckVisibility();
    }

    setConversation(convo) {
        this._conversation = convo;
        this._messages = [];
        this._allLoaded = false;
        this._replyContext = null;
        this._hidePopover();
        this._hideAutocomplete();
        this._renderReplyPreview();

        const name = convo.node_name || convo.node_id || '';
        const isChannel = (convo.node_id || '').startsWith('broadcast:');
        const proto = convo.protocol === 'meshcore' ? 'MC' : 'MT';

        this._headerName.textContent = name;
        this._headerSubtitle.textContent = isChannel
            ? 'Public channel · all listeners on this PSK'
            : 'Direct message';
        this._headerBadge.textContent = proto;
        this._headerBadge.className = 'msg-chat__protocol-badge ' +
            (convo.protocol === 'meshcore' ? 'msg-chat__protocol-badge--mc' : 'msg-chat__protocol-badge--mt');

        this._headerAvatar.textContent = isChannel ? '#' : this._initials(name);
        this._headerAvatar.className = 'msg-chat__avatar' + (
            isChannel ? ' msg-chat__avatar--channel'
            : convo.protocol === 'meshcore' ? ' msg-chat__avatar--mc'
            : ' msg-chat__avatar--mt'
        );

        this._messagesEl.innerHTML = '';
        this._lastDayKey = null;
        this._container.classList.remove('msg-chat--empty');
        this._input.disabled = false;
        this._sendBtn.disabled = false;
        this._updateWantAckVisibility();
        this._updateByteCounter();
        this._input.focus();
        this._loadMessages();
    }

    addMessage(msg) {
        this._messages.push(msg);
        this._appendBubble(msg);
        this._scrollToBottom();
    }

    addOptimisticMessage(text, protocol) {
        const msg = {
            id: Date.now(),
            direction: 'sent',
            text: text,
            node_id: this._conversation?.node_id || '',
            node_name: '',
            protocol: protocol || this._conversation?.protocol || 'meshtastic',
            channel: 0,
            timestamp: new Date().toISOString(),
            status: 'sending...',
            packet_id: '',
        };
        this.addMessage(msg);
        return msg;
    }

    updateMessageStatus(tempId, status, packetId) {
        const bubble = this._messagesEl.querySelector(`[data-msg-id="${tempId}"]`);
        if (bubble) {
            const meta = bubble.querySelector('.msg-bubble__meta');
            if (meta) {
                const time = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
                meta.textContent = `${time} · ${status}`;
            }
        }
    }

    clear() {
        this.clearChat();
    }

    async _loadMessages() {
        if (!this._conversation || this._loading) return;
        this._loading = true;

        try {
            const nodeId = encodeURIComponent(this._conversation.node_id);
            const res = await fetch(`/api/messages/conversation/${nodeId}?limit=50`);
            const messages = await res.json();
            this._messages = messages;

            this._messagesEl.innerHTML = '';
            if (messages.length === 0) {
                this._renderConversationEmptyState();
            } else {
                messages.forEach(msg => this._appendBubble(msg));
                this._scrollToBottom();
            }

            if (messages.length < 50) this._allLoaded = true;

            await fetch(`/api/messages/conversation/${nodeId}/read`, { method: 'POST' });
        } catch (e) {
            console.error('Failed to load messages:', e);
        } finally {
            this._loading = false;
        }
    }

    _renderEmptyState() {
        this._messagesEl.innerHTML = `
            <div class="msg-chat__placeholder">
                <div class="msg-chat__placeholder-icon" aria-hidden="true">
                    <svg viewBox="0 0 64 64" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <path d="M14 18a6 6 0 016-6h24a6 6 0 016 6v18a6 6 0 01-6 6H28l-9 8v-8h-1a6 6 0 01-4-2"
                              stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" />
                        <circle cx="26" cy="27" r="1.8" fill="currentColor" />
                        <circle cx="32" cy="27" r="1.8" fill="currentColor" />
                        <circle cx="38" cy="27" r="1.8" fill="currentColor" />
                    </svg>
                </div>
                <h3 class="msg-chat__placeholder-title">No conversation selected</h3>
                <p class="msg-chat__placeholder-body">
                    Choose a channel or direct message in the list on the left,
                    or tap <span class="msg-chat__placeholder-cta">+ New</span>
                    to start a DM with a specific node.
                </p>
            </div>
        `;
    }

    _renderConversationEmptyState() {
        this._messagesEl.innerHTML = `
            <div class="msg-chat__placeholder msg-chat__placeholder--inset">
                <p class="msg-chat__placeholder-body">
                    No messages in this thread yet. Type below and send
                    when you are ready.
                </p>
            </div>
        `;
    }

    _initials(name) {
        if (!name) return '?';
        const trimmed = name.trim();
        const parts = trimmed.split(/[\s_\-.]+/).filter(Boolean);
        if (parts.length === 0) return trimmed[0].toUpperCase();
        if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
        return (parts[0][0] + parts[parts.length - 1][0]).toUpperCase();
    }

    _isChannelThread() {
        return (this._conversation?.node_id || '').startsWith('broadcast:');
    }

    _appendBubble(msg) {
        const empty = this._messagesEl.querySelector('.msg-chat__placeholder');
        if (empty) empty.remove();
        this._insertDaySeparator(msg.timestamp);
        const bubble = document.createElement('div');
        this._populateBubble(bubble, msg);
        this._messagesEl.appendChild(bubble);
    }

    _buildBubbleEl(msg) {
        const bubble = document.createElement('div');
        this._populateBubble(bubble, msg);
        return bubble;
    }

    _populateBubble(bubble, msg) {
        const direction = msg.direction || 'received';
        bubble.className = `msg-bubble msg-bubble--${direction}`;
        bubble.dataset.msgId = msg.id;
        if (msg.packet_id) bubble.dataset.pktId = msg.packet_id;

        const time = msg.timestamp
            ? new Date(msg.timestamp).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
            : '';
        const statusText = msg.status && msg.status !== 'delivered' && msg.status !== 'read'
            ? ` · ${msg.status}` : '';
        const signalHtml = this._buildSignalHtml(msg);
        const textHtml = this._compose
            ? this._compose.renderMentionHtml(msg.text, (s) => this._esc(s))
            : this._esc(msg.text);

        let inner = '';
        if (direction === 'received' || direction === 'overheard') {
            const name = this._receivedSenderLabel(msg);
            const sourceId = msg.source_id || msg.sender_meta?.node_id || '';
            const proto = msg.protocol || this._conversation?.protocol || 'meshtastic';
            const protoClass = proto === 'meshcore' ? 'msg-bubble__sender--mc' : 'msg-bubble__sender--mt';
            if (name) {
                inner += `
                    <button type="button"
                            class="msg-bubble__sender ${protoClass}"
                            data-action="sender-info"
                            data-source-id="${this._esc(sourceId)}"
                            aria-haspopup="dialog">${this._esc(name)}</button>`;
            }
            const showDm = this._isChannelThread() && sourceId;
            inner += `
                <div class="msg-bubble__actions">
                    <button type="button" class="msg-bubble__action" data-action="reply">Reply</button>
                    ${showDm ? '<button type="button" class="msg-bubble__action" data-action="dm">DM</button>' : ''}
                </div>`;
        }

        inner += `
            <div class="msg-bubble__text">${textHtml}</div>
            <div class="msg-bubble__meta">${time}${statusText}${signalHtml}</div>`;

        bubble.innerHTML = inner;
        bubble._msgData = msg;
    }

    _scrollToBottom() {
        requestAnimationFrame(() => {
            this._messagesEl.scrollTop = this._messagesEl.scrollHeight;
        });
    }

    _handleSend() {
        const text = this._input.value;
        if (!text.trim() || !this._conversation) return;
        const bytes = this._compose.byteLength(text);
        if (bytes > this._compose.MAX_BYTES) return;

        this._input.value = '';
        this._replyContext = null;
        this._renderReplyPreview();
        this._updateByteCounter();
        this._hideAutocomplete();
        this._onSend(text, this._conversation);
    }

    _build() {
        this._container.classList.add('msg-chat', 'msg-chat--empty');
        this._container.innerHTML = `
            <div class="msg-chat__header">
                <span class="msg-chat__avatar" aria-hidden="true"></span>
                <div class="msg-chat__header-text">
                    <span class="msg-chat__name"></span>
                    <span class="msg-chat__subtitle"></span>
                </div>
                <span class="msg-chat__protocol-badge"></span>
            </div>
            <div class="msg-chat__messages"></div>
            <div class="msg-compose-wrap">
                <div class="msg-reply-preview" hidden></div>
                <div class="msg-autocomplete" hidden role="listbox"></div>
                <div class="msg-compose">
                    <textarea class="msg-compose__input" placeholder="Type a message…" disabled rows="1"></textarea>
                    <div class="msg-compose__footer">
                        <label class="msg-compose__ack" hidden>
                            <input type="checkbox" class="msg-compose__ack-input" />
                            Request ACK
                        </label>
                        <span class="msg-compose__bytes">0 / 228</span>
                        <button class="msg-compose__send" type="button" disabled>
                            <span class="msg-compose__send-label">Send</span>
                            <span class="msg-compose__send-arrow" aria-hidden="true">→</span>
                        </button>
                    </div>
                </div>
            </div>
        `;

        this._headerName = this._container.querySelector('.msg-chat__name');
        this._headerSubtitle = this._container.querySelector('.msg-chat__subtitle');
        this._headerBadge = this._container.querySelector('.msg-chat__protocol-badge');
        this._headerAvatar = this._container.querySelector('.msg-chat__avatar');
        this._messagesEl = this._container.querySelector('.msg-chat__messages');
        this._input = this._container.querySelector('.msg-compose__input');
        this._sendBtn = this._container.querySelector('.msg-compose__send');
        this._byteCounter = this._container.querySelector('.msg-compose__bytes');
        this._replyPreview = this._container.querySelector('.msg-reply-preview');
        this._autocompleteEl = this._container.querySelector('.msg-autocomplete');
        this._ackLabel = this._container.querySelector('.msg-compose__ack');
        this._ackInput = this._container.querySelector('.msg-compose__ack-input');

        this._renderEmptyState();

        this._sendBtn.addEventListener('click', () => this._handleSend());
        this._input.addEventListener('keydown', (e) => this._onInputKeydown(e));
        this._input.addEventListener('input', () => {
            this._updateByteCounter();
            this._maybeShowAutocomplete();
        });
        this._ackInput?.addEventListener('change', () => {
            this._wantAck = !!this._ackInput.checked;
        });

        this._messagesEl.addEventListener('scroll', () => {
            if (this._messagesEl.scrollTop === 0 && !this._allLoaded) {
                this._loadOlderMessages();
            }
        });

        this._messagesEl.addEventListener('click', (e) => this._onBubbleClick(e));
        this._messagesEl.addEventListener('mouseenter', (e) => {
            const btn = e.target.closest('[data-action="sender-info"]');
            if (!btn || !window.matchMedia('(hover: hover)').matches) return;
            clearTimeout(this._popoverTimer);
            this._popoverTimer = setTimeout(() => this._toggleSenderPopover(btn, btn.closest('.msg-bubble')?._msgData, true), 350);
        }, true);
        this._messagesEl.addEventListener('mouseleave', (e) => {
            const btn = e.target.closest('[data-action="sender-info"]');
            if (!btn) return;
            clearTimeout(this._popoverTimer);
        }, true);

        document.addEventListener('click', (e) => {
            if (this._activePopover && !this._activePopover.contains(e.target)
                && !e.target.closest('[data-action="sender-info"]')) {
                this._hidePopover();
            }
            if (this._autocompleteEl && !this._autocompleteEl.hidden
                && !this._autocompleteEl.contains(e.target)
                && e.target !== this._input) {
                this._hideAutocomplete();
            }
        });
    }

    _onInputKeydown(e) {
        if (this._autocompleteEl && !this._autocompleteEl.hidden) {
            const items = [...this._autocompleteEl.querySelectorAll('.msg-autocomplete__item')];
            if (e.key === 'ArrowDown') {
                e.preventDefault();
                this._autocompleteIdx = Math.min(this._autocompleteIdx + 1, items.length - 1);
                this._highlightAutocompleteItem(items);
                return;
            }
            if (e.key === 'ArrowUp') {
                e.preventDefault();
                this._autocompleteIdx = Math.max(this._autocompleteIdx - 1, 0);
                this._highlightAutocompleteItem(items);
                return;
            }
            if (e.key === 'Enter' && this._autocompleteIdx >= 0 && items[this._autocompleteIdx]) {
                e.preventDefault();
                items[this._autocompleteIdx].click();
                return;
            }
            if (e.key === 'Escape') {
                this._hideAutocomplete();
                return;
            }
        }
        if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            this._handleSend();
        }
    }

    _highlightAutocompleteItem(items) {
        items.forEach((el, i) => {
            el.classList.toggle('msg-autocomplete__item--active', i === this._autocompleteIdx);
        });
    }

    _onBubbleClick(e) {
        const btn = e.target.closest('[data-action]');
        if (!btn) return;
        const bubble = btn.closest('.msg-bubble');
        const msg = bubble?._msgData;
        if (!msg) return;

        const action = btn.dataset.action;
        if (action === 'sender-info') {
            e.preventDefault();
            if (window.matchMedia('(hover: hover)').matches) {
                this._hidePopover();
                this._openNodeFromMessage(msg);
            } else {
                this._toggleSenderPopover(btn, msg);
            }
            return;
        }
        if (action === 'reply') {
            this._startReply(msg);
            return;
        }
        if (action === 'dm') {
            this._openDmFromMessage(msg);
        }
        if (action === 'open-node') {
            this._openNodeFromMessage(msg);
        }
        if (action === 'view-map') {
            const meta = msg.sender_meta || {};
            if (meta.latitude != null && meta.longitude != null && this._onViewOnMap) {
                this._onViewOnMap(meta.latitude, meta.longitude);
            }
        }
        if (action === 'view-packet') {
            this._openPacketDetail(msg.packet_id);
        }
    }

    _toggleSenderPopover(anchor, msg, forceShow = false) {
        if (!msg) return;
        if (!forceShow && this._activePopover?.anchor === anchor) {
            this._hidePopover();
            return;
        }
        this._hidePopover();
        const pop = this._buildSenderPopover(anchor, msg);
        document.body.appendChild(pop);
        this._activePopover = { el: pop, anchor };
        this._positionPopover(pop, anchor);
    }

    _positionPopover(pop, anchor) {
        const rect = anchor.getBoundingClientRect();
        pop.style.top = `${rect.bottom + 6}px`;
        pop.style.left = `${Math.max(8, rect.left)}px`;
    }

    _hidePopover() {
        if (this._activePopover?.el) {
            this._activePopover.el.remove();
        }
        this._activePopover = null;
    }

    _buildSenderPopover(anchor, msg) {
        const meta = msg.sender_meta || {};
        const name = this._receivedSenderLabel(msg);
        const sourceId = msg.source_id || meta.node_id || anchor.dataset.sourceId || '';
        const proto = msg.protocol || this._conversation?.protocol || 'meshtastic';
        const nodeLabel = this._compose.formatNodeId(sourceId, proto);
        const heard = this._compose.timeAgo(meta.last_heard);
        const rssi = msg.rssi ?? meta.latest_rssi;
        const hops = meta.hop_count ?? meta.latest_hops;
        const hasGps = meta.latitude != null && meta.longitude != null;

        const pop = document.createElement('div');
        pop.className = 'msg-sender-popover';
        pop.setAttribute('role', 'dialog');
        pop.innerHTML = `
            <div class="msg-sender-popover__name">${this._esc(name)}</div>
            <div class="msg-sender-popover__id">${this._esc(nodeLabel)}</div>
            <div class="msg-sender-popover__stats">
                ${heard !== '--' ? `<span>Last heard ${this._esc(heard)}</span>` : ''}
                ${rssi != null ? `<span>${Number(rssi).toFixed(1)} dBm</span>` : ''}
                ${hops != null ? `<span>${hops} hop${hops === 1 ? '' : 's'}</span>` : ''}
            </div>
            <div class="msg-sender-popover__actions">
                <button type="button" class="msg-sender-popover__btn" data-pop-action="reply">Reply</button>
                ${this._isChannelThread() && sourceId
                    ? '<button type="button" class="msg-sender-popover__btn" data-pop-action="dm">DM</button>'
                    : ''}
                <button type="button" class="msg-sender-popover__btn" data-pop-action="profile">Profile</button>
                ${hasGps
                    ? '<button type="button" class="msg-sender-popover__btn" data-pop-action="map">Map</button>'
                    : ''}
                ${msg.packet_id
                    ? '<button type="button" class="msg-sender-popover__btn" data-pop-action="packet">Packet</button>'
                    : ''}
            </div>
        `;

        pop.addEventListener('click', (e) => {
            const act = e.target.closest('[data-pop-action]')?.dataset.popAction;
            if (!act) return;
            if (act === 'reply') this._startReply(msg);
            if (act === 'dm') this._openDmFromMessage(msg);
            if (act === 'profile') this._openNodeFromMessage(msg);
            if (act === 'map' && hasGps && this._onViewOnMap) {
                this._onViewOnMap(meta.latitude, meta.longitude);
            }
            if (act === 'packet') this._openPacketDetail(msg.packet_id);
            this._hidePopover();
        });

        pop.addEventListener('dblclick', () => {
            this._openNodeFromMessage(msg);
            this._hidePopover();
        });

        return pop;
    }

    _openNodeFromMessage(msg) {
        const sourceId = msg.source_id || msg.sender_meta?.node_id;
        if (!sourceId || !this._onOpenNode) return;
        this._onOpenNode({
            node_id: sourceId,
            long_name: msg.node_name || msg.sender_meta?.display_name,
            short_name: msg.sender_meta?.short_name,
            protocol: msg.protocol || this._conversation?.protocol,
        });
    }

    _openDmFromMessage(msg) {
        const sourceId = msg.source_id || msg.sender_meta?.node_id;
        if (!sourceId || !this._onOpenDm) return;
        this._onOpenDm({
            node_id: sourceId,
            node_name: msg.node_name || msg.sender_meta?.display_name || sourceId,
            protocol: msg.protocol || this._conversation?.protocol,
            is_broadcast: false,
        });
    }

    _startReply(msg) {
        const name = this._receivedSenderLabel(msg);
        this._replyContext = { name, text: msg.text, msg };
        this._renderReplyPreview();

        let prefix;
        if (this._isChannelThread()) {
            prefix = this._compose.buildChannelReplyPrefix(
                this._conversation,
                msg.sender_meta,
                name,
            );
        } else {
            prefix = this._compose.buildDmReplyPrefix(msg.text);
        }
        const maxBytes = this._compose.MAX_BYTES;
        prefix = this._compose.truncateToByteLimit(prefix, maxBytes);
        this._input.value = prefix;
        this._updateByteCounter();
        this._input.focus();
        const pos = this._input.value.length;
        this._input.setSelectionRange(pos, pos);
    }

    _renderReplyPreview() {
        if (!this._replyPreview) return;
        if (!this._replyContext) {
            this._replyPreview.hidden = true;
            this._replyPreview.innerHTML = '';
            return;
        }
        const preview = (this._replyContext.text || '').replace(/\s+/g, ' ').trim().slice(0, 80);
        this._replyPreview.hidden = false;
        this._replyPreview.innerHTML = `
            <span class="msg-reply-preview__label">Replying to <strong>${this._esc(this._replyContext.name)}</strong></span>
            <span class="msg-reply-preview__text">${this._esc(preview)}</span>
            <button type="button" class="msg-reply-preview__close" aria-label="Cancel reply">&times;</button>
        `;
        this._replyPreview.querySelector('.msg-reply-preview__close')
            ?.addEventListener('click', () => {
                this._replyContext = null;
                this._renderReplyPreview();
            });
    }

    async _ensureContacts() {
        if (this._contactsCache || this._contactsLoading) return;
        this._contactsLoading = true;
        try {
            const res = await fetch('/api/messages/contacts');
            this._contactsCache = await res.json();
        } catch (e) {
            this._contactsCache = [];
        } finally {
            this._contactsLoading = false;
        }
    }

    async _maybeShowAutocomplete() {
        if (!this._isChannelThread() || !this._input) return;
        const val = this._input.value || '';
        const atIdx = val.lastIndexOf('@');
        if (atIdx < 0) {
            this._hideAutocomplete();
            return;
        }
        const tail = val.slice(atIdx + 1);
        if (tail.includes(' ') || tail.includes(']')) {
            this._hideAutocomplete();
            return;
        }
        await this._ensureContacts();
        const matches = this._compose.filterContacts(
            this._contactsCache,
            this._conversation?.protocol,
            tail,
        );
        if (!matches.length) {
            this._hideAutocomplete();
            return;
        }
        this._autocompleteEl.hidden = false;
        this._autocompleteIdx = 0;
        this._autocompleteEl.innerHTML = matches.map((c, i) => `
            <button type="button" class="msg-autocomplete__item${i === 0 ? ' msg-autocomplete__item--active' : ''}"
                    role="option" data-idx="${i}">
                <span class="msg-autocomplete__name">${this._esc(c.name || c.node_id)}</span>
                <span class="msg-autocomplete__id">${this._esc(c.node_id)}</span>
            </button>
        `).join('');
        this._autocompleteEl.querySelectorAll('.msg-autocomplete__item').forEach((btn, i) => {
            btn.addEventListener('click', () => {
                this._compose.insertMention(this._input, this._conversation, matches[i]);
                this._hideAutocomplete();
                this._updateByteCounter();
            });
        });
    }

    _hideAutocomplete() {
        if (this._autocompleteEl) {
            this._autocompleteEl.hidden = true;
            this._autocompleteEl.innerHTML = '';
        }
        this._autocompleteIdx = -1;
    }

    _updateByteCounter() {
        if (!this._byteCounter || !this._compose) return;
        const bytes = this._compose.byteLength(this._input?.value || '');
        const max = this._compose.MAX_BYTES;
        this._byteCounter.textContent = `${bytes} / ${max}`;
        this._byteCounter.classList.toggle('msg-compose__bytes--over', bytes > max);
        if (this._sendBtn) {
            this._sendBtn.disabled = !this._input?.value.trim() || bytes > max;
        }
    }

    _updateWantAckVisibility() {
        if (!this._ackLabel) return;
        const show = this._conversation
            && !this._isChannelThread()
            && this._conversation.protocol !== 'meshcore';
        this._ackLabel.hidden = !show;
        if (!show) {
            this._wantAck = false;
            if (this._ackInput) this._ackInput.checked = false;
        }
    }

    async _openPacketDetail(packetId) {
        if (!packetId || !window.PacketDetailModal) return;
        try {
            const res = await fetch('/api/packets?limit=300');
            const packets = await res.json();
            const pkt = packets.find((p) => p.packet_id === packetId);
            if (pkt) window.PacketDetailModal.show(pkt);
        } catch (e) {
            console.warn('Packet lookup failed:', e);
        }
    }

    async _loadOlderMessages() {
        if (!this._conversation || this._loading || this._allLoaded) return;
        if (this._messages.length === 0) return;
        this._loading = true;

        try {
            const oldest = this._messages[0];
            const nodeId = encodeURIComponent(this._conversation.node_id);
            const res = await fetch(
                `/api/messages/conversation/${nodeId}?limit=50&before=${oldest.timestamp}`
            );
            const older = await res.json();
            if (older.length === 0) {
                this._allLoaded = true;
                return;
            }

            const scrollBefore = this._messagesEl.scrollHeight;
            const frag = document.createDocumentFragment();
            let prevKey = null;
            older.forEach(msg => {
                const key = msg.timestamp ? this._dayKey(msg.timestamp) : null;
                if (key && key !== prevKey) {
                    frag.appendChild(this._buildDaySeparatorEl(msg.timestamp));
                    prevKey = key;
                }
                frag.appendChild(this._buildBubbleEl(msg));
            });

            const firstExistingKey = this._messages[0]?.timestamp
                ? this._dayKey(this._messages[0].timestamp) : null;
            if (prevKey && prevKey === firstExistingKey) {
                const existingSep = this._messagesEl.querySelector('.msg-day-separator');
                if (existingSep) existingSep.remove();
            }

            this._messagesEl.prepend(frag);
            this._messages = [...older, ...this._messages];

            const scrollAfter = this._messagesEl.scrollHeight;
            this._messagesEl.scrollTop = scrollAfter - scrollBefore;
        } catch (e) {
            console.error('Failed to load older messages:', e);
        } finally {
            this._loading = false;
        }
    }

    updateBubbleSignal(packetId, rssi, snr, rxCount) {
        const bubble = this._messagesEl.querySelector(`[data-pkt-id="${CSS.escape(packetId)}"]`);
        if (!bubble) return;

        const meta = bubble.querySelector('.msg-bubble__meta');
        if (!meta) return;

        const sig = meta.querySelector('.msg-signal');
        if (sig) sig.remove();
        const rx = meta.querySelector('.msg-rx-count');
        if (rx) rx.remove();

        const fakeMsg = { direction: 'received', rssi, snr, rx_count: rxCount };
        meta.insertAdjacentHTML('beforeend', this._buildSignalHtml(fakeMsg));
    }

    _buildSignalHtml(msg) {
        if (msg.direction === 'sent' || msg.rssi == null) return '';

        const rssi = msg.rssi;
        const snr = msg.snr;
        const level = rssi > -80 ? 5 : rssi > -95 ? 4 : rssi > -110 ? 3 : rssi > -125 ? 2 : 1;
        const cls = level >= 4 ? 'excellent' : level === 3 ? 'good' : level === 2 ? 'fair' : 'poor';

        let bars = '';
        for (let i = 1; i <= 5; i++) {
            const active = i <= level ? 'active' : '';
            bars += `<span class="sig-bar sig-bar--h${i} ${active}"></span>`;
        }

        const snrStr = snr != null ? ` · ${snr.toFixed(1)} dB` : '';
        const rxStr = (msg.rx_count || 1) > 1
            ? `<span class="msg-rx-count" title="Received via ${msg.rx_count} RF paths">×${msg.rx_count}</span>`
            : '';
        return `<span class="msg-signal msg-signal--${cls}">${bars}<span class="msg-signal__val">${rssi.toFixed(1)}${snrStr}</span></span>${rxStr}`;
    }

    _insertDaySeparator(ts) {
        if (!ts) return;
        const key = this._dayKey(ts);
        if (key === this._lastDayKey) return;
        this._lastDayKey = key;
        this._messagesEl.appendChild(this._buildDaySeparatorEl(ts));
    }

    _buildDaySeparatorEl(ts) {
        const d = new Date(ts);
        const now = new Date();
        const sameDay = d.getFullYear() === now.getFullYear()
            && d.getMonth() === now.getMonth()
            && d.getDate() === now.getDate();

        let label;
        if (sameDay) {
            label = 'Today';
        } else {
            const yesterday = new Date(now);
            yesterday.setDate(yesterday.getDate() - 1);
            const sameYesterday = d.getFullYear() === yesterday.getFullYear()
                && d.getMonth() === yesterday.getMonth()
                && d.getDate() === yesterday.getDate();
            label = sameYesterday
                ? 'Yesterday'
                : d.toLocaleDateString([], { weekday: 'short', month: 'short', day: 'numeric' });
        }

        const div = document.createElement('div');
        div.className = 'msg-day-separator';
        div.textContent = label;
        return div;
    }

    _dayKey(ts) {
        const d = new Date(ts);
        return `${d.getFullYear()}-${d.getMonth()}-${d.getDate()}`;
    }

    _receivedSenderLabel(msg) {
        let name = (msg.node_name || '').trim();
        if (name.startsWith('broadcast:')) name = '';
        if (name.toLowerCase() === 'broadcast') name = '';
        if (!name && msg.source_id) {
            const sid = String(msg.source_id);
            if (sid && sid !== 'ffffffff' && !sid.startsWith('broadcast')) {
                name = sid.length > 6 ? `!${sid.slice(-4)}` : sid;
            }
        }
        if (!name) {
            const nid = msg.node_id || '';
            if (!nid.startsWith('broadcast:')) name = nid;
        }
        return name;
    }

    _esc(str) {
        const el = document.createElement('span');
        el.textContent = str || '';
        return el.innerHTML;
    }
}
