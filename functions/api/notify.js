export async function onRequestPost(context) {
    const { request, env } = context;

    try {
        const order = await request.json();
        const BOT_TOKEN = env.TELEGRAM_BOT_TOKEN;
        const OWNER_ID = env.OWNER_TELEGRAM_ID;

        const itemsStr = (order.items || [])
            .map(i => `• ${i.title} (${i.size}) × ${i.qty}`)
            .join('\n');

        const text =
            `🔥 <b>НОВЫЙ ЗАКАЗ ${order.order_number}</b>\n\n` +
            `👤 <b>Клиент:</b> ${order.customer_name} (${order.customer_phone})\n` +
            `🚚 <b>Доставка:</b> ${order.delivery_address || 'Самовывоз'}\n` +
            `📦 <b>Состав:</b>\n${itemsStr}\n` +
            (order.promo_code ? `🎟 <b>Промокод:</b> ${order.promo_code} (-${order.discount_amount} ₸)\n` : '') +
            `💰 <b>Итого:</b> ${order.grand_total} ₸ (${order.payment_method})\n` +
            (order.comment ? `💬 <b>Комментарий:</b> ${order.comment}\n` : '') +
            `\n📌 Статус: <b>⏳ Ожидание оплаты</b>`;

        const keyboard = {
            inline_keyboard: [
                [
                    { text: '⏳ Ожидание оплаты', callback_data: `st:${order.order_number}:awaiting_payment` },
                    { text: '✅ Оплачен / Сборка', callback_data: `st:${order.order_number}:paid` }
                ],
                [
                    { text: '🚗 Выехал / В пути', callback_data: `st:${order.order_number}:in_transit` },
                    { text: '🏁 Приехали', callback_data: `st:${order.order_number}:delivered` }
                ]
            ]
        };

        await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                chat_id: OWNER_ID,
                text,
                parse_mode: 'HTML',
                reply_markup: keyboard
            })
        });

        return new Response(JSON.stringify({ ok: true }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
        });
    } catch (e) {
        return new Response(JSON.stringify({ ok: false }), { status: 500 });
    }
}
