export async function onRequest(context) {
    const { request, env } = context;

    if (request.method !== 'POST') {
        return new Response('ATLAS STORE Bot Active', { status: 200 });
    }

    const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
    const OWNER_ID = Number(env.OWNER_TELEGRAM_ID);
    const SUPABASE_URL = (env.SUPABASE_URL || '').replace(/\/rest\/v1\/?$/, '').replace(/\/+$/, '');
    const SUPABASE_SERVICE_KEY = (env.SUPABASE_SERVICE_ROLE_KEY || '').trim();

    const tgSend = async (chatId, text, replyMarkup = null) => {
        const body = { chat_id: chatId, text, parse_mode: 'HTML' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    };

    const tgEdit = async (chatId, messageId, text, replyMarkup = null) => {
        const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML' };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    };

    const sbQuery = async (path, method = 'GET', body = null) => {
        if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
            throw new Error(`Ключи не заданы: URL=${Boolean(SUPABASE_URL)}, KEY=${Boolean(SUPABASE_SERVICE_KEY)}`);
        }
        const headers = {
            apikey: SUPABASE_SERVICE_KEY,
            'Content-Type': 'application/json',
            Prefer: 'return=representation'
        };
        if (SUPABASE_SERVICE_KEY.startsWith('eyJ')) {
            headers.Authorization = `Bearer ${SUPABASE_SERVICE_KEY}`;
        }
        const opts = { method, headers };
        if (body) opts.body = JSON.stringify(body);

        const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, opts);
        const rawText = await r.text();
        let data;
        try {
            data = rawText ? JSON.parse(rawText) : [];
        } catch (_) {
            throw new Error(`Ответ не JSON (${r.status}): ${rawText.slice(0, 120)}`);
        }
        if (!r.ok) {
            throw new Error(data.message || data.hint || `Ошибка базы (${r.status})`);
        }
        return data;
    };

    const statusKeyboard = (orderNumber) => ({
        inline_keyboard: [
            [
                { text: '⏳ Ожидание оплаты', callback_data: `st:${orderNumber}:awaiting_payment` },
                { text: '✅ Оплачен / Сборка', callback_data: `st:${orderNumber}:paid` }
            ],
            [
                { text: '🚗 Выехал / В пути', callback_data: `st:${orderNumber}:in_transit` },
                { text: '🏁 Приехали', callback_data: `st:${orderNumber}:delivered` }
            ]
        ]
    });

    const STATUS_NAMES = {
        awaiting_payment: '⏳ Ожидание оплаты',
        paid: '✅ Оплачен / Собирается',
        in_transit: '🚗 Выехал / В пути',
        delivered: '🏁 Приехали / Доставлен'
    };

    let chatIdForError = null;

    try {
        const update = await request.json();

        if (update.callback_query) {
            const cb = update.callback_query;
            chatIdForError = cb.message?.chat?.id;
            if (cb.from.id !== OWNER_ID) return new Response('OK', { status: 200 });

            const [, orderNumber, newStatus] = cb.data.split(':');
            await sbQuery(`orders?order_number=eq.${encodeURIComponent(orderNumber)}`, 'PATCH', {
                status: newStatus
            });

            await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    callback_query_id: cb.id,
                    text: `Обновлено: ${STATUS_NAMES[newStatus]}`
                })
            });

            const baseText = cb.message.text.split('\n\n📌 Статус:')[0];
            await tgEdit(
                cb.message.chat.id,
                cb.message.message_id,
                `${baseText}\n\n📌 Статус: <b>${STATUS_NAMES[newStatus]}</b>`,
                statusKeyboard(orderNumber)
            );
            return new Response('OK', { status: 200 });
        }

        const msg = update.message;
        if (!msg || !msg.text) return new Response('OK', { status: 200 });
        chatIdForError = msg.chat.id;

        if (msg.from.id !== OWNER_ID) {
            await tgSend(msg.chat.id, `⛔ Доступ закрыт. Ваш ID: <code>${msg.from.id}</code>`);
            return new Response('OK', { status: 200 });
        }

        const text = msg.text.trim();
        const parts = text.split(/\s+/);
        const cmd = parts[0].toLowerCase().split('@')[0];

        if (cmd === '/start' || cmd === '/help') {
            await tgSend(
                msg.chat.id,
                `<b>ATLAS STORE — Пульт управления</b>\n\n` +
                `📦 <b>Товары и цены:</b>\n` +
                `<code>/list</code> — список всех товаров и их ID\n` +
                `<code>/price 5 6990</code> — поставить цену 6990 ₸ товару #5\n` +
                `<code>/sale 5 6990 8990</code> — сделать скидку (новая и старая цена)\n` +
                `<code>/stock 5 3</code> — остаток в штуках\n` +
                `<code>/status 5 in-stock</code> — наличие (<code>in-stock</code> или <code>in-transit</code>)\n\n` +
                `🎟 <b>Промокоды:</b>\n` +
                `<code>/promo ATLAS10 10%</code> — промокод на 10% скидки\n` +
                `<code>/promo VIP1000 1000</code> — промокод на 1000 ₸\n` +
                `<code>/delpromo ATLAS10</code> — удалить промокод\n` +
                `<code>/promos</code> — список активных промокодов\n\n` +
                `🚚 <b>Доставка и заказы:</b>\n` +
                `<code>/order ATL-1234</code> — открыть заказ и управлять статусом`
            );
        } else if (cmd === '/list') {
            const products = await sbQuery('products?select=id,title,price,max_qty,status_label&order=id.asc');
            const listText = products
                .map(p => `<b>#${p.id}</b> ${p.title} — <b>${p.price} ₸</b> (${p.max_qty} шт., ${p.status_label})`)
                .join('\n');
            await tgSend(msg.chat.id, listText || 'Каталог пуст.');
        } else if (cmd === '/price' && parts.length >= 3) {
            const id = Number(parts[1]);
            const price = Number(parts[2]);
            await sbQuery(`products?id=eq.${id}`, 'PATCH', { price, old_price: null });
            await tgSend(msg.chat.id, `✅ Цена товара <b>#${id}</b> изменена на <b>${price} ₸</b>`);
        } else if (cmd === '/sale' && parts.length >= 4) {
            const id = Number(parts[1]);
            const price = Number(parts[2]);
            const oldPrice = Number(parts[3]);
            const pct = Math.round((1 - price / oldPrice) * 100);
            await sbQuery(`products?id=eq.${id}`, 'PATCH', {
                price,
                old_price: oldPrice,
                badge: `-${pct}%`
            });
            await tgSend(msg.chat.id, `🔥 Скидка -${pct}% на товар <b>#${id}</b>: <b>${price} ₸</b> (было ${oldPrice} ₸)`);
        } else if (cmd === '/stock' && parts.length >= 3) {
            const id = Number(parts[1]);
            const qty = Number(parts[2]);
            await sbQuery(`products?id=eq.${id}`, 'PATCH', { max_qty: qty });
            await tgSend(msg.chat.id, `📦 Остаток товара <b>#${id}</b>: <b>${qty} шт.</b>`);
        } else if (cmd === '/status' && parts.length >= 3) {
            const id = Number(parts[1]);
            const st = parts[2] === 'in-stock' ? 'in-stock' : 'in-transit';
            const label = st === 'in-stock' ? 'В наличии' : 'В пути';
            await sbQuery(`products?id=eq.${id}`, 'PATCH', {
                status: st,
                status_label: label,
                badge: label
            });
            await tgSend(msg.chat.id, `🔄 Статус товара <b>#${id}</b>: <b>${label}</b>`);
        } else if (cmd === '/promo' && parts.length >= 3) {
            const code = parts[1].toUpperCase();
            const rawVal = parts[2];
            const isPercent = rawVal.endsWith('%');
            const val = Number(rawVal.replace('%', ''));
            await sbQuery('promocodes', 'POST', {
                code,
                discount_type: isPercent ? 'percent' : 'fixed',
                discount_value: val,
                is_active: true
            });
            await tgSend(msg.chat.id, `🎟 Промокод <b>${code}</b> создан (скидка ${rawVal})`);
        } else if (cmd === '/delpromo' && parts.length >= 2) {
            const code = parts[1].toUpperCase();
            await sbQuery(`promocodes?code=eq.${encodeURIComponent(code)}`, 'DELETE');
            await tgSend(msg.chat.id, `🗑 Промокод <b>${code}</b> удалён`);
        } else if (cmd === '/promos') {
            const promos = await sbQuery('promocodes?select=*');
            const txt = promos.length
                ? promos.map(p => `• <code>${p.code}</code> — ${p.discount_value}${p.discount_type === 'percent' ? '%' : ' ₸'}`).join('\n')
                : 'Активных промокодов нет.';
            await tgSend(msg.chat.id, txt);
        } else if (cmd === '/order' && parts.length >= 2) {
            const raw = parts[1].toUpperCase();
            const code = raw.startsWith('#') ? raw : '#' + raw;
            const orders = await sbQuery(`orders?order_number=eq.${encodeURIComponent(code)}`);
            if (!orders.length) {
                await tgSend(msg.chat.id, `❌ Заказ <b>${code}</b> не найден.`);
            } else {
                const o = orders[0];
                const itemsStr = (o.items || []).map(i => `• ${i.title} (${i.size}) × ${i.qty}`).join('\n');
                await tgSend(
                    msg.chat.id,
                    `🛍 <b>Заказ ${o.order_number}</b>\n` +
                    `👤 ${o.customer_name} (${o.customer_phone})\n` +
                    `📍 ${o.delivery_address || 'Самовывоз'}\n` +
                    `${itemsStr}\n` +
                    `💰 Итого: <b>${o.grand_total} ₸</b> (${o.payment_method})\n\n` +
                    `📌 Статус: <b>${STATUS_NAMES[o.status] || o.status}</b>`,
                    statusKeyboard(o.order_number)
                );
            }
        }
    } catch (err) {
        if (chatIdForError && BOT_TOKEN) {
            await tgSend(chatIdForError, `⚠️ <b>Ошибка:</b> ${err.message}`);
        }
    }

    return new Response(JSON.stringify({ ok: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
    });
}
