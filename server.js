require('dotenv').config();
const express = require('express');
const cors = require('cors');
const mongoose = require('mongoose');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const Stripe = require('stripe');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const PORT = process.env.PORT || 3000;

app.use(helmet({ contentSecurityPolicy: false }));

const limiter = rateLimit({
    windowMs: 15 * 60 * 1000,
    max: 100,
    message: { error: 'Demasiadas solicitudes, intenta más tarde.' }
});
app.use('/api/', limiter);
app.use(cors());

app.use('/api/donations/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

mongoose.connect(process.env.MONGO_URI)
    .then(() => console.log('Base de datos conectada de forma segura'))
    .catch(err => console.error('Error de conexión a MongoDB:', err));

const DonationSchema = new mongoose.Schema({
    name: { type: String, required: true, trim: true },
    email: { type: String, required: true, trim: true, lowercase: true },
    amount: { type: Number, required: true, min: 1, max: 50000 },
    currency: { type: String, enum: ['MXN', 'USD'], default: 'MXN' },
    commission: { type: Number, default: 0 },
    paymentMethod: { type: String, default: 'Stripe' },
    stripeSessionId: { type: String },
    paymentStatus: {
        type: String,
        enum: ['pending', 'completed', 'failed', 'withdrawn'],
        default: 'pending'
    },
    createdAt: { type: Date, default: Date.now }
});

const Donation = mongoose.model('Donation', DonationSchema);

const REGEX = {
    email: /^[^\s@]+@[^\s@]+\.[^\s@]+$/,
    name: /^[a-zA-ZÁÉÍÓÚáéíóúÑñÜü\s'-]{2,100}$/
};

app.post('/api/donations/create-payment', async (req, res) => {
    try {
        const { name, email, amount, currency = 'MXN' } = req.body;

        if (!name || !REGEX.name.test(name)) {
            return res.status(400).json({ error: 'Nombre inválido o vacío.' });
        }
        if (!email || !REGEX.email.test(email)) {
            return res.status(400).json({ error: 'Correo electrónico inválido.' });
        }

        const upperCurrency = (currency || 'MXN').toUpperCase();
        if (!['MXN', 'USD'].includes(upperCurrency)) {
            return res.status(400).json({ error: 'Moneda no soportada.' });
        }

        const minAmount = 1;
        const maxAmount = upperCurrency === 'MXN' ? 50000 : 3000;

        if (!amount || typeof amount !== 'number' || amount < minAmount || amount > maxAmount) {
            return res.status(400).json({ error: `El monto debe estar entre $${minAmount} y $${maxAmount} ${upperCurrency}.` });
        }

        const COMMISSION_RATE = 0.05;
        const commission = Number((amount * COMMISSION_RATE).toFixed(2));

        const donation = await Donation.create({
            name,
            email,
            amount,
            currency: upperCurrency,
            commission,
            paymentMethod: 'Stripe',
            paymentStatus: 'pending'
        });

        const frontendUrl = process.env.FRONTEND_URL || `${req.protocol}://${req.get('host')}`;

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: upperCurrency.toLowerCase(),
                    product_data: { name: `Aporte directo para David (${upperCurrency})` },
                    unit_amount: Math.round(amount * 100)
                },
                quantity: 1
            }],
            mode: 'payment',
            client_reference_id: donation._id.toString(),
            success_url: `${frontendUrl}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${frontendUrl}/cancel`
        });

        donation.stripeSessionId = session.id;
        await donation.save();

        res.json({ sessionId: session.id });

    } catch (error) {
        console.error('Error al crear la sesión de pago:', error);
        res.status(500).json({ error: error.message || 'Error interno al procesar la solicitud.' });
    }
});

app.post('/api/donations/webhook', async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        try {
            await Donation.findOneAndUpdate(
                { stripeSessionId: session.id },
                { paymentStatus: 'completed' }
            );
        } catch (dbError) {
            console.error('Error actualizando base de datos:', dbError);
        }
    }

    res.json({ received: true });
});

app.get('/', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="es">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Aportaciones Seguras - David</title>
    <script src="https://js.stripe.com/v3/"></script>
    <style>
        :root {
            --primary: #0f766e; --primary-hover: #115e59;
            --bg-gradient: linear-gradient(135deg, #f8fafc 0%, #e2e8f0 100%);
            --card-bg: #ffffff; --text-main: #0f172a; --text-muted: #64748b; --border-color: #cbd5e1;
            --error-bg: #fef2f2; --error-border: #f87171; --error-text: #991b1b;
            --success-bg: #f0fdf4; --success-border: #4ade80; --success-text: #166534;
            --warning-bg: #fffbeb; --warning-border: #fcd34d; --warning-text: #92400e;
        }
        body { font-family: system-ui, -apple-system, sans-serif; background: var(--bg-gradient); color: var(--text-main); margin: 0; padding: 20px; display: flex; justify-content: center; align-items: center; min-height: 100vh; }
        .donation-container { background-color: var(--card-bg); max-width: 480px; width: 100%; padding: 35px; border-radius: 20px; box-shadow: 0 15px 35px rgba(15, 23, 42, 0.08); box-sizing: border-box; }
        .beneficiary-banner { background: #f0fdf4; border: 1px solid #bbf7d0; padding: 14px; border-radius: 12px; text-align: center; margin-bottom: 20px; }
        .beneficiary-banner h3 { margin: 0; color: #166534; font-size: 17px; font-weight: 800; }
        .beneficiary-banner p { margin: 4px 0 0 0; color: #15803d; font-size: 13px; font-weight: 500; }
        .donation-header h2 { margin: 0 0 6px 0; text-align: center; font-size: 22px; font-weight: 800; color: #0f172a; }
        .donation-header p { text-align: center; color: var(--text-muted); font-size: 13px; margin-bottom: 20px; line-height: 1.4; }
        .form-group { margin-bottom: 18px; }
        .form-group label { display: block; font-size: 12px; font-weight: 700; text-transform: uppercase; letter-spacing: 0.5px; margin-bottom: 6px; color: #475569; }
        .form-group select, .form-group input { width: 100%; padding: 12px 15px; border: 1px solid var(--border-color); border-radius: 10px; font-size: 15px; box-sizing: border-box; outline: none; background: #fff; transition: all 0.2s ease; }
        .form-group select:focus, .form-group input:focus { border-color: var(--primary); box-shadow: 0 0 0 3px rgba(15, 118, 110, 0.1); }
        .amount-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 12px; }
        .amount-btn { background-color: #f8fafc; border: 2px solid var(--border-color); border-radius: 10px; padding: 12px; font-size: 16px; font-weight: 700; cursor: pointer; transition: all 0.2s ease; color: var(--text-main); }
        .amount-btn:hover { border-color: var(--primary); background-color: #f0fdf4; }
        .amount-btn.active { border-color: var(--primary); background-color: var(--success-bg); color: var(--primary); transform: scale(1.02); }
        .custom-amount-wrapper { position: relative; margin-bottom: 15px; }
        .currency-symbol { position: absolute; left: 15px; top: 50%; transform: translateY(-50%); font-size: 18px; font-weight: 700; color: var(--text-muted); }
        .custom-amount-input { width: 100%; padding: 14px 14px 14px 38px !important; border: 2px solid var(--border-color) !important; border-radius: 10px !important; font-size: 18px !important; font-weight: 700 !important; box-sizing: border-box; outline: none; }
        .summary-box { background: #f8fafc; border: 1px dashed var(--border-color); padding: 12px 15px; border-radius: 10px; font-size: 13px; color: var(--text-muted); margin-bottom: 20px; display: flex; justify-content: space-between; align-items: center; }
        .summary-box span { font-weight: 700; color: var(--primary); }
        .donate-btn { background-color: var(--primary); color: white; border: none; width: 100%; padding: 15px; font-size: 16px; font-weight: 700; border-radius: 12px; cursor: pointer; transition: background-color 0.2s, transform 0.1s; display: flex; justify-content: center; align-items: center; gap: 10px; box-shadow: 0 4px 12px rgba(15, 118, 110, 0.2); }
        .donate-btn:hover { background-color: var(--primary-hover); }
        .donate-btn:active { transform: scale(0.98); }
        .donate-btn:disabled { opacity: 0.7; cursor: not-allowed; transform: none; }
        .spinner { width: 20px; height: 20px; border: 3px solid rgba(255,255,255,0.3); border-radius: 50%; border-top-color: #fff; animation: spin 0.8s linear infinite; display: none; }
        @keyframes spin { to { transform: rotate(360deg); } }
        .security-note { text-align: center; font-size: 12px; color: var(--text-muted); margin-top: 20px; }
        .toast-container { position: fixed; top: 20px; right: 20px; display: flex; flex-direction: column; gap: 10px; z-index: 9999; max-width: 350px; width: 100%; }
        .toast { padding: 14px 18px; border-radius: 12px; font-size: 14px; font-weight: 600; box-shadow: 0 8px 20px rgba(0,0,0,0.1); border: 1px solid transparent; }
        .toast.success { background-color: var(--success-bg); border-color: var(--success-border); color: var(--success-text); }
        .toast.error { background-color: var(--error-bg); border-color: var(--error-border); color: var(--error-text); }
        .toast.warning { background-color: var(--warning-bg); border-color: var(--warning-border); color: var(--warning-text); }
        .toast.info { background-color: #e0f2fe; border-color: #38bdf8; color: #0369a1; }
    </style>
</head>
<body>
    <div id="toast-container" class="toast-container"></div>
    <div class="donation-container">
        <div class="beneficiary-banner">
            <h3>👤 Destinatario: David</h3>
            <p>Aportación directa, segura y cifrada.</p>
        </div>
        <div class="donation-header">
            <h2>Fondo de Aportes</h2>
            <p>Elige tu moneda, ingresa el monto y paga de forma segura con tarjeta.</p>
        </div>
        <form id="donation-form" novalidate>
            <div class="form-group">
                <label for="currency">Moneda de Pago</label>
                <select id="currency" onchange="changeCurrency()">
                    <option value="MXN" selected>MXN ($ Pesos Mexicanos)</option>
                    <option value="USD">USD ($ Dólares)</option>
                </select>
            </div>
            <div class="form-group">
                <label>Monto de la Aportación</label>
                <div class="amount-grid" id="amount-presets">
                    <button type="button" class="amount-btn" onclick="setAmount(100, this)">100</button>
                    <button type="button" class="amount-btn active" onclick="setAmount(250, this)">250</button>
                    <button type="button" class="amount-btn" onclick="setAmount(500, this)">500</button>
                </div>
                <div class="custom-amount-wrapper">
                    <span id="currency-symbol" class="currency-symbol">$</span>
                    <input type="number" id="custom-amount" class="custom-amount-input" value="250" min="1" max="50000" step="any" oninput="updateSummary()" required>
                </div>
                <div class="summary-box">
                    <span>Desglose estimado:</span>
                    <span id="summary-text">250 MXN (Comisión: 12.50 MXN)</span>
                </div>
            </div>
            <div class="form-group">
                <label for="name">Tu Nombre Completo</label>
                <input type="text" id="name" placeholder="Ej. Juan Pérez" autocomplete="name" required>
            </div>
            <div class="form-group">
                <label for="email">Tu Correo Electrónico</label>
                <input type="email" id="email" placeholder="correo@ejemplo.com" autocomplete="email" required>
            </div>
            <button type="submit" id="submit-btn" class="donate-btn">
                <span id="btn-text">Proceder al Pago con Tarjeta</span>
                <div id="btn-spinner" class="spinner"></div>
            </button>
        </form>
        <div class="security-note">🔒 Procesado de forma segura mediante pasarela Stripe</div>
    </div>
    <script>
        // ⚠️ REEMPLAZA ESTA LLAVE POR TU LLAVE PUBLICA DE STRIPE (pk_live_... o pk_test_...)
        const stripe = Stripe('pk_live_51...TU_LLAVE_PUBLICA_AQUI');

        const LIMITS = {
            MXN: { min: 1, max: 50000, presets: [100, 250, 500] },
            USD: { min: 1, max: 3000, presets: [10, 25, 50] }
        };
        const REGEX = { email: /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/, name: /^[a-zA-ZÁÉÍÓÚáéíóúÑñÜü\\s'-]{2,100}$/ };

        function notify(message, type = "info") {
            const container = document.getElementById('toast-container');
            if (!container) return;
            const toast = document.createElement('div');
            toast.className = 'toast ' + type;
            toast.textContent = message;
            container.appendChild(toast);
            setTimeout(() => toast.remove(), 4000);
        }

        function updateSummary() {
            const currency = document.getElementById('currency').value;
            const amount = parseFloat(document.getElementById('custom-amount').value) || 0;
            const commission = (amount * 0.05).toFixed(2);
            document.getElementById('summary-text').textContent = `${amount.toLocaleString()} ${currency} (Comisión: ${commission} ${currency})`;
        }

        function changeCurrency() {
            const currency = document.getElementById('currency').value;
            const symbol = document.getElementById('currency-symbol');
            const customInput = document.getElementById('custom-amount');
            const presetsContainer = document.getElementById('amount-presets');

            symbol.textContent = currency === 'MXN' ? '$' : 'US$';
            const limits = LIMITS[currency];
            customInput.min = limits.min;
            customInput.max = limits.max;
            customInput.value = limits.presets[1];

            presetsContainer.innerHTML = '';
            limits.presets.forEach((val, idx) => {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'amount-btn' + (idx === 1 ? ' active' : '');
                btn.textContent = val;
                btn.onclick = () => setAmount(val, btn);
                presetsContainer.appendChild(btn);
            });
            updateSummary();
        }

        function setAmount(amount, buttonElement) {
            document.getElementById('custom-amount').value = amount;
            document.querySelectorAll('.amount-btn').forEach(b => b.classList.remove('active'));
            if (buttonElement) buttonElement.classList.add('active');
            updateSummary();
        }

        async function processPayment(event) {
            event.preventDefault();
            const submitBtn = document.getElementById('submit-btn');
            const btnText = document.getElementById('btn-text');
            const btnSpinner = document.getElementById('btn-spinner');
            
            const name = document.getElementById('name').value.trim();
            const email = document.getElementById('email').value.trim().toLowerCase();
            const currency = document.getElementById('currency').value;
            const amount = Number(document.getElementById('custom-amount').value);
            const limits = LIMITS[currency];

            if (!name || !REGEX.name.test(name)) { notify('⚠️ Ingresa un nombre válido', 'warning'); return; }
            if (!email || !REGEX.email.test(email)) { notify('⚠️ Ingresa un correo electrónico válido', 'warning'); return; }
            if (!amount || amount < limits.min || amount > limits.max) { 
                notify(`⚠️ El monto debe estar entre $${limits.min} y $${limits.max} ${currency}`, 'warning'); 
                return; 
            }

            submitBtn.disabled = true;
            btnText.textContent = 'Abriendo pasarela de pago...';
            btnSpinner.style.display = 'block';

            try {
                const response = await fetch('/api/donations/create-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, email, amount, currency })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Error en el servidor');

                if (result.sessionId) {
                    await stripe.redirectToCheckout({ sessionId: result.sessionId });
                }
            } catch (err) {
                notify('⚠️ ' + err.message, 'error');
                submitBtn.disabled = false;
                btnText.textContent = 'Proceder al Pago con Tarjeta';
                btnSpinner.style.display = 'none';
            }
        }
        document.getElementById('donation-form').addEventListener('submit', processPayment);
        updateSummary();
    </script>
</body>
</html>`);
});

app.get('/success', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Éxito</title>
<style>body{font-family:system-ui;background:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}
.card{background:#fff;padding:40px;border-radius:20px;text-align:center;box-shadow:0 15px 35px rgba(0,0,0,0.08);max-width:400px;}
h2{color:#0f766e;margin-bottom:10px;}p{color:#64748b;font-size:14px;line-height:1.5;}.btn{display:block;background:#0f766e;color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:700;margin-top:20px;}</style>
</head>
<body><div class="card"><h2>¡Pago Exitoso!</h2><p>Tu aportación ha sido procesada y registrada correctamente.</p><a href="/" class="btn">Regresar al Inicio</a></div></body>
</html>`);
});

app.get('/cancel', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Cancelado</title>
<style>body{font-family:system-ui;background:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}
.card{background:#fff;padding:40px;border-radius:20px;text-align:center;box-shadow:0 15px 35px rgba(0,0,0,0.08);max-width:400px;}
h2{color:#b91c1c;margin-bottom:10px;}p{color:#64748b;font-size:14px;line-height:1.5;}.btn{display:block;background:#475569;color:#fff;text-decoration:none;padding:14px;border-radius:12px;font-weight:700;margin-top:20px;}</style>
</head>
<body><div class="card"><h2>Pago Cancelado</h2><p>El proceso de pago fue cancelado y no se ha realizado ningún cargo.</p><a href="/" class="btn">Intentar Nuevamente</a></div></body>
</html>`);
});

app.listen(PORT, () => {
    console.log(`Servidor unificado activo en http://localhost:${PORT}`);
});
