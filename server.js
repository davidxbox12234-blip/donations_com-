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
    max: 50,
    message: { error: 'Demasiadas solicitudes desde esta IP, intenta más tarde.' }
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
    amount: { type: Number, required: true, min: 10, max: 50000 },
    currency: { type: String, default: 'MXN' },
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
        const { name, email, amount } = req.body;

        if (!name || !REGEX.name.test(name)) {
            return res.status(400).json({ error: 'Nombre inválido o vacío.' });
        }
        if (!email || !REGEX.email.test(email)) {
            return res.status(400).json({ error: 'Correo electrónico inválido.' });
        }
        if (!amount || typeof amount !== 'number' || amount < 10 || amount > 50000) {
            return res.status(400).json({ error: 'El monto debe estar entre $10 y $50,000 MXN.' });
        }

        const donation = await Donation.create({
            name,
            email,
            amount,
            paymentMethod: 'Stripe',
            paymentStatus: 'pending'
        });

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [{
                price_data: {
                    currency: 'mxn',
                    product_data: { name: 'Aporte / Donación Segura' },
                    unit_amount: Math.round(amount * 100)
                },
                quantity: 1
            }],
            mode: 'payment',
            client_reference_id: donation._id.toString(),
            success_url: `${process.env.FRONTEND_URL}/success?session_id={CHECKOUT_SESSION_ID}`,
            cancel_url: `${process.env.FRONTEND_URL}/cancel`
        });

        donation.stripeSessionId = session.id;
        await donation.save();

        res.json({ sessionId: session.id });

    } catch (error) {
        console.error('Error al crear la sesión de pago:', error);
        res.status(500).json({ error: 'Error interno al procesar la solicitud.' });
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
    <title>Plataforma de Transacciones Seguras</title>
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
        .donation-container { background-color: var(--card-bg); max-width: 480px; width: 100%; padding: 40px; border-radius: 16px; box-shadow: 0 10px 25px rgba(15, 23, 42, 0.08); box-sizing: border-box; }
        .donation-header h2 { margin: 0 0 10px 0; text-align: center; font-size: 24px; font-weight: 700; }
        .donation-header p { text-align: center; color: var(--text-muted); font-size: 14px; margin-bottom: 25px; }
        .currency-label { text-align: right; font-size: 12px; color: var(--text-muted); margin-bottom: 5px; font-weight: 600; }
        .amount-grid { display: grid; grid-template-columns: repeat(3, 1fr); gap: 10px; margin-bottom: 15px; }
        .amount-btn { background-color: #f8fafc; border: 2px solid var(--border-color); border-radius: 10px; padding: 12px; font-size: 16px; font-weight: 700; cursor: pointer; transition: all 0.2s ease; color: var(--text-main); }
        .amount-btn.active { border-color: var(--primary); background-color: var(--success-bg); color: var(--primary); }
        .custom-amount-wrapper { position: relative; margin-bottom: 20px; }
        .currency-symbol { position: absolute; left: 15px; top: 50%; transform: translateY(-50%); font-size: 18px; font-weight: 600; color: var(--text-muted); }
        .custom-amount-input { width: 100%; padding: 14px 14px 14px 35px; border: 2px solid var(--border-color); border-radius: 10px; font-size: 18px; font-weight: 600; box-sizing: border-box; outline: none; }
        .custom-amount-input:focus { border-color: var(--primary); }
        .form-group { margin-bottom: 20px; }
        .form-group label { display: block; font-size: 14px; font-weight: 600; margin-bottom: 8px; }
        .form-group input { width: 100%; padding: 12px 15px; border: 1px solid var(--border-color); border-radius: 8px; font-size: 15px; box-sizing: border-box; outline: none; }
        .form-group input:focus { border-color: var(--primary); }
        .donate-btn { background-color: var(--primary); color: white; border: none; width: 100%; padding: 15px; font-size: 16px; font-weight: 700; border-radius: 10px; cursor: pointer; transition: background-color 0.2s; }
        .donate-btn:hover { background-color: var(--primary-hover); }
        .donate-btn:disabled { opacity: 0.7; cursor: not-allowed; }
        .security-note { text-align: center; font-size: 12px; color: var(--text-muted); margin-top: 20px; }
        .toast-container { position: fixed; top: 20px; right: 20px; display: flex; flex-direction: column; gap: 10px; z-index: 9999; max-width: 350px; width: 100%; }
        .toast { padding: 14px 18px; border-radius: 10px; font-size: 14px; font-weight: 600; box-shadow: 0 4px 12px rgba(0,0,0,0.1); border: 1px solid transparent; }
        .toast.success { background-color: var(--success-bg); border-color: var(--success-border); color: var(--success-text); }
        .toast.error { background-color: var(--error-bg); border-color: var(--error-border); color: var(--error-text); }
        .toast.warning { background-color: var(--warning-bg); border-color: var(--warning-border); color: var(--warning-text); }
        .toast.info { background-color: #e0f2fe; border-color: #38bdf8; color: #0369a1; }
    </style>
</head>
<body>
    <div id="toast-container" class="toast-container"></div>
    <div class="donation-container">
        <div class="donation-header">
            <h2>Fondo de Aportes y Retiros</h2>
            <p>Ingresa los datos para procesar tu transacción de forma cifrada.</p>
        </div>
        <form id="donation-form" novalidate>
            <div class="currency-label">Moneda: MXN ($)</div>
            <div class="amount-grid">
                <button type="button" class="amount-btn" onclick="setAmount(100, this)">100</button>
                <button type="button" class="amount-btn active" onclick="setAmount(250, this)">250</button>
                <button type="button" class="amount-btn" onclick="setAmount(500, this)">500</button>
            </div>
            <div class="custom-amount-wrapper">
                <span class="currency-symbol">$</span>
                <input type="number" id="custom-amount" class="custom-amount-input" value="250" min="10" max="50000" step="any" required>
            </div>
            <div class="form-group">
                <label for="name">Nombre completo</label>
                <input type="text" id="name" placeholder="Ej. Juan Pérez" autocomplete="name" required>
            </div>
            <div class="form-group">
                <label for="email">Correo electrónico</label>
                <input type="email" id="email" placeholder="correo@ejemplo.com" autocomplete="email" required>
            </div>
            <button type="submit" id="submit-btn" class="donate-btn">Proceder al Pago Seguro</button>
        </form>
        <div class="security-note">🔒 Conexión cifrada TLS 1.3 | Procesamiento protegido</div>
    </div>
    <script>
        const LIMITS = { MIN_AMOUNT: 10, MAX_AMOUNT: 50000, TIMEOUT: 15000 };
        const REGEX = { email: /^[^\\s@]+@[^\\s@]+\\.[^\\s@]+$/, name: /^[a-zA-ZÁÉÍÓÚáéíóúÑñÜü\\s'-]{2,100}$/ };
        const stripe = Stripe('TU_CLAVE_PUBLICA_DE_STRIPE');

        function notify(message, type = "info") {
            const container = document.getElementById('toast-container');
            if (!container) return;
            const toast = document.createElement('div');
            toast.className = 'toast ' + type;
            toast.textContent = message;
            container.appendChild(toast);
            setTimeout(() => toast.remove(), 4000);
        }

        function setAmount(amount, buttonElement) {
            document.getElementById('custom-amount').value = amount;
            document.querySelectorAll('.amount-btn').forEach(b => b.classList.remove('active'));
            if (buttonElement) buttonElement.classList.add('active');
        }

        async function processPayment(event) {
            event.preventDefault();
            const submitBtn = document.getElementById('submit-btn');
            const name = document.getElementById('name').value.trim();
            const email = document.getElementById('email').value.trim().toLowerCase();
            const amount = Number(document.getElementById('custom-amount').value);

            if (!name || !REGEX.name.test(name)) { notify('⚠️ Nombre inválido', 'warning'); return; }
            if (!email || !REGEX.email.test(email)) { notify('⚠️ Correo inválido', 'warning'); return; }
            if (!amount || amount < LIMITS.MIN_AMOUNT || amount > LIMITS.MAX_AMOUNT) { notify('⚠️ Monto fuera de rango ($10 - $50,000)', 'warning'); return; }

            submitBtn.disabled = true;
            submitBtn.textContent = 'Procesando...';

            try {
                const response = await fetch('/api/donations/create-payment', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ name, email, amount })
                });
                const result = await response.json();
                if (!response.ok) throw new Error(result.error || 'Error en el servidor');

                if (result.sessionId) {
                    await stripe.redirectToCheckout({ sessionId: result.sessionId });
                }
            } catch (err) {
                notify('⚠️ ' + err.message, 'error');
                submitBtn.disabled = false;
                submitBtn.textContent = 'Proceder al Pago Seguro';
            }
        }
        document.getElementById('donation-form').addEventListener('submit', processPayment);
    </script>
</body>
</html>`);
});

app.get('/success', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Éxito</title>
<style>body{font-family:system-ui;background:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}
.card{background:#fff;padding:40px;border-radius:16px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.08);max-width:400px;}
h2{color:#0f766e;}p{color:#64748b;font-size:14px;}.btn{display:block;background:#0f766e;color:#fff;text-decoration:none;padding:12px;border-radius:8px;font-weight:700;margin-top:20px;}</style>
</head>
<body><div class="card"><h2>¡Pago Exitoso!</h2><p>Tu transacción ha sido verificada y registrada correctamente.</p><a href="/" class="btn">Regresar al Inicio</a></div></body>
</html>`);
});

app.get('/cancel', (req, res) => {
    res.send(`<!DOCTYPE html>
<html lang="es">
<head><meta charset="UTF-8"><title>Cancelado</title>
<style>body{font-family:system-ui;background:#f8fafc;display:flex;justify-content:center;align-items:center;height:100vh;margin:0;}
.card{background:#fff;padding:40px;border-radius:16px;text-align:center;box-shadow:0 10px 25px rgba(0,0,0,0.08);max-width:400px;}
h2{color:#b91c1c;}p{color:#64748b;font-size:14px;}.btn{display:block;background:#475569;color:#fff;text-decoration:none;padding:12px;border-radius:8px;font-weight:700;margin-top:20px;}</style>
</head>
<body><div class="card"><h2>Pago Cancelado</h2><p>El proceso fue cancelado y no se ha realizado ningún cargo.</p><a href="/" class="btn">Intentar Nuevamente</a></div></body>
</html>`);
});

app.listen(PORT, () => {
    console.log(`Servidor unificado activo en http://localhost:${PORT}`);
});
