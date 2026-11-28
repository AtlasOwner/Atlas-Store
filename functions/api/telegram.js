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
        const body = { chat_id: chatId, text, parse_mode: 'HTML', disable_web_page_preview: true };
        if (replyMarkup) body.reply_markup = replyMarkup;
        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body)
        });
    };

    const tgEdit = async (chatId, messageId, text, replyMarkup = null) => {
        const body = { chat_id: chatId, message_id: messageId, text, parse_mode: 'HTML', disable_web_page_preview: true };
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

    const restoreOrderStock = async (order) => {
        if (!order || !Array.isArray(order.items)) return;
        for (const item of order.items) {
            const prods = await sbQuery(`products?id=eq.${Number(item.id)}&select=id,max_qty`);
            if (prods.length) {
                const currentQty = Number(prods[0].max_qty || 0);
                await sbQuery(`products?id=eq.${Number(item.id)}`, 'PATCH', {
                    max_qty: currentQty + Number(item.qty || 1)
                });
            }
        }
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
            ],
            [
                { text: '❌ Отменить заказ (вернуть товар)', callback_data: `st:${orderNumber}:cancelled` }
            ]
        ]
    });

    const STATUS_NAMES = {
        awaiting_payment: '⏳ Ожидание оплаты',
        paid: '✅ Оплачен / Собирается',
        in_transit: '🚗 Выехал / В пути',
        delivered: '🏁 Приехали / Доставлен',
        cancelled: '❌ Отменён (остатки возвращены)'
    };

    const formatOrderCard = (o) => {
        const itemsStr = (o.items || []).map(i => `• ${i.title} (${i.size}) × ${i.qty}`).join('\n');
        const addr = o.delivery_address || 'Самовывоз';
        const gisLink = addr !== 'Самовывоз'
            ? `\n🗺 <a href="https://2gis.kz/aktobe/search/${encodeURIComponent('Актобе ' + addr)}">Открыть адрес в 2GIS</a>`
            : '';
        return (
            `🛍 <b>Заказ ${o.order_number}</b>\n` +
            `👤 ${o.customer_name} (${o.customer_phone})\n` +
            `📍 ${addr}${gisLink}\n` +
            `${itemsStr}\n` +
            (o.promo_code ? `🎟 Промокод: ${o.promo_code} (-${o.discount_amount} ₸)\n` : '') +
            `💰 Итого: <b>${o.grand_total} ₸</b> (${o.payment_method})\n` +
            (o.comment ? `💬 ${o.comment}\n` : '') +
            `\n📌 Статус: <b>${STATUS_NAMES[o.status] || o.status}</b>`
        );
    };

    let chatIdForError = null;

    try {
        const update = await request.json();

        if (update.callback_query) {
            const cb = update.callback_query;
            chatIdForError = cb.message?.chat?.id;
            if (cb.from.id !== OWNER_ID) return new Response('OK', { status: 200 });

            const [, orderNumber, newStatus] = cb.data.split(':');
            const existingOrders = await sbQuery(`orders?order_number=eq.${encodeURIComponent(orderNumber)}`);
            const currentOrder = existingOrders[0];

            if (currentOrder && newStatus === 'cancelled' && currentOrder.status !== 'cancelled') {
                await restoreOrderStock(currentOrder);
            }

            const updated = await sbQuery(`orders?order_number=eq.${encodeURIComponent(orderNumber)}`, 'PATCH', {
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

            if (updated.length) {
                await tgEdit(
                    cb.message.chat.id,
                    cb.message.message_id,
                    formatOrderCard(updated[0]),
                    statusKeyboard(orderNumber)
                );
            }
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
                `<b>ATLAS STORE — Автономный пульт</b>\n\n` +
                `📦 <b>Каталог, цены и фото:</b>\n` +
                `<code>/list</code> — все товары, ID, цены и остатки\n` +
                `<code>/price 5 6990</code> — новая цена 6990 ₸ товару #5\n` +
                `<code>/sale 5 6990 8990</code> — скидка (новая и старая цена)\n` +
                `<code>/stock 5 3</code> — остаток в штуках (<code>0</code> = распродано)\n` +
                `<code>/status 5 in-stock</code> — наличие (<code>in-stock</code> / <code>in-transit</code>)\n` +
                `<code>/photo 5 ССЫЛКА</code> — сменить главное фото товара #5\n` +
                `<code>/add Название | Одежда | 14990 | M (170–180 см) | ССЫЛКА</code> — добавить товар\n` +
                `<code>/del 9</code> — удалить товар #9\n\n` +
                `🎟 <b>Промокоды:</b>\n` +
                `<code>/promo ALIKHAN15 15%</code> — разовый промокод (сгорит сам после 1 заказа)\n` +
                `<code>/promo SALE10 10% multi</code> — многоразовый промокод\n` +
                `<code>/delpromo ALIKHAN15</code> — удалить промокод\n` +
                `<code>/promos</code> — список активных промокодов\n\n` +
                `🚚 <b>Заказы и касса:</b>\n` +
                `<code>/orders</code> — активные заказы в работе\n` +
                `<code>/order ATL-1234</code> — открыть заказ и кнопки статуса\n` +
                `<code>/cancel ATL-1234</code> — отменить заказ и вернуть остатки\n` +
                `<code>/stats</code> — статистика выручки`
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
            const prods = await sbQuery(`products?id=eq.${id}&select=status`);
            const baseStatus = prods[0]?.status || 'in-stock';
            const label = qty <= 0 ? 'Распродано' : (baseStatus === 'in-stock' ? 'В наличии' : 'В пути');
            await sbQuery(`products?id=eq.${id}`, 'PATCH', {
                max_qty: qty,
                status_label: label,
                badge: label
            });
            await tgSend(msg.chat.id, `📦 Остаток товара <b>#${id}</b>: <b>${qty} шт.</b> (${label})`);
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
        } else if (cmd === '/photo' && parts.length >= 3) {
            const id = Number(parts[1]);
            const url = parts[2].trim();
            await sbQuery(`products?id=eq.${id}`, 'PATCH', { images: [url] });
            await tgSend(msg.chat.id, `🖼 Главное фото товара <b>#${id}</b> обновлено.`);
        } else if (cmd === '/add') {
            const rawPayload = text.replace(/^\/add\s*/i, '');
            const fields = rawPayload.split('|').map(s => s.trim());
            if (fields.length < 5) {
                await tgSend(
                    msg.chat.id,
                    `Формат команды:\n<code>/add Название | Одежда | 14990 | M (170–180 см) | Ссылка_на_фото</code>\n(Категория: <code>Одежда</code> или <code>Головные уборы</code>)`
                );
                return new Response('OK', { status: 200 });
            }
            const [title, catRaw, priceRaw, sizeRaw, imgUrl] = fields;
            const isClothing = catRaw.toLowerCase().includes('одежд');
            const created = await sbQuery('products', 'POST', {
                title,
                subtitle: 'ATLAS STORE • Новое поступление',
                category: isClothing ? 'clothing' : 'headwear',
                category_label: isClothing ? 'Одежда' : 'Головные уборы',
                price: Number(priceRaw),
                status: 'in-stock',
                status_label: 'В наличии',
                badge: 'Новинка',
                sizes: [sizeRaw],
                max_qty: 3,
                popularity: 95,
                description: title,
                images: [imgUrl]
            });
            await tgSend(msg.chat.id, `✅ Товар <b>#${created[0]?.id || ''} ${title}</b> добавлен в каталог (${priceRaw} ₸).`);
        } else if (cmd === '/del' && parts.length >= 2) {
            const id = Number(parts[1]);
            await sbQuery(`products?id=eq.${id}`, 'DELETE');
            await tgSend(msg.chat.id, `🗑 Товар <b>#${id}</b> удалён из каталога.`);
        }} else if (cmd === '/promo' && parts.length >= 3) {
            const code = parts[1].toUpperCase();
            const rawVal = parts[2];
            const isMulti = (parts[3] || '').toLowerCase() === 'multi';
            const isPercent = rawVal.endsWith('%');
            const val = Number(rawVal.replace('%', ''));
            await fetch(`${SUPABASE_URL}/rest/v1/promocodes?on_conflict=code`, {
                method: 'POST',
                headers: {
                    apikey: SUPABASE_SERVICE_KEY,
                    'Content-Type': 'application/json',
                    Prefer: 'resolution=merge-duplicates,return=representation'
                },
                body: JSON.stringify({
                    code,
                    discount_type: isPercent ? 'percent' : 'fixed',
                    discount_value: val,
                    is_active: true,
                    is_multi: isMulti
                })
            });
            await tgSend(
                msg.chat.id,
                `🎟 Промокод <b>${code}</b> активен (скидка ${rawVal}, ${isMulti ? 'многоразовый' : 'разовый — сгорит после 1 заказа'})`
            );
        } else if (cmd === '/delpromo' && parts.length >= 2) {
            const code = parts[1].toUpperCase();
            await sbQuery(`promocodes?code=eq.${encodeURIComponent(code)}`, 'DELETE');
            await tgSend(msg.chat.id, `🗑 Промокод <b>${code}</b> удалён`);
        } else if (cmd === '/promos') {
            const promos = await sbQuery('promocodes?is_active=eq.true&select=*');
            const txt = promos.length
                ? promos.map(p => `• <code>${p.code}</code> — ${p.discount_value}${p.discount_type === 'percent' ? '%' : ' ₸'} (${p.is_multi ? 'многоразовый' : 'разовый'})`).join('\n')
                : 'Активных промокодов нет.';
            await tgSend(msg.chat.id, txt);
        } else if (cmd === '/orders') {
            const activeOrders = await sbQuery('orders?status=in.(awaiting_payment,paid,in_transit)&order=created_at.desc&limit=10');
            if (!activeOrders.length) {
                await tgSend(msg.chat.id, '✅ Активных заказов в работе сейчас нет.');
            } else {
                const lines = activeOrders.map(o =>
                    `• <code>${o.order_number}</code> — <b>${o.grand_total} ₸</b> (${o.customer_name}, ${STATUS_NAMES[o.status] || o.status})`
                ).join('\n');
                await tgSend(msg.chat.id, `📋 <b>Активные заказы:</b>\n\n${lines}\n\nЧтобы открыть управление: <code>/order ATL-1234</code>`);
            }
        } else if (cmd === '/cancel' && parts.length >= 2) {
            const raw = parts[1].toUpperCase();
            const code = raw.startsWith('#') ? raw : '#' + raw;
            const orders = await sbQuery(`orders?order_number=eq.${encodeURIComponent(code)}`);
            if (!orders.length) {
                await tgSend(msg.chat.id, `❌ Заказ <b>${code}</b> не найден.`);
            } else {
                if (orders[0].status !== 'cancelled') {
                    await restoreOrderStock(orders[0]);
                }
                const updated = await sbQuery(`orders?order_number=eq.${encodeURIComponent(code)}`, 'PATCH', {
                    status: 'cancelled'
                });
                await tgSend(msg.chat.id, formatOrderCard(updated[0]), statusKeyboard(code));
            }
        } else if (cmd === '/order' && parts.length >= 2) {
            const raw = parts[1].toUpperCase();
            const code = raw.startsWith('#') ? raw : '#' + raw;
            const orders = await sbQuery(`orders?order_number=eq.${encodeURIComponent(code)}`);
            if (!orders.length) {
                await tgSend(msg.chat.id, `❌ Заказ <b>${code}</b> не найден.`);
            } else {
                await tgSend(msg.chat.id, formatOrderCard(orders[0]), statusKeyboard(orders[0].order_number));
            }
        } else if (cmd === '/stats') {
            const paidOrders = await sbQuery('orders?status=in.(paid,in_transit,delivered)&select=grand_total,created_at');
            const totalSum = paidOrders.reduce((acc, o) => acc + Number(o.grand_total || 0), 0);
            const todayStr = new Date().toISOString().slice(0, 10);
            const todayOrders = paidOrders.filter(o => (o.created_at || '').startsWith(todayStr));
            const todaySum = todayOrders.reduce((acc, o) => acc + Number(o.grand_total || 0), 0);
            await tgSend(
                msg.chat.id,
                `📊 <b>Статистика ATLAS STORE</b>\n\n` +
                `Сегодня: <b>${todayOrders.length} зак.</b> на <b>${todaySum.toLocaleString('ru-RU')} ₸</b>\n` +
                `Всего оплачено: <b>${paidOrders.length} зак.</b> на <b>${totalSum.toLocaleString('ru-RU')} ₸</b>`
            );
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
