const { createBot, createProvider, createFlow, addKeyword } = require('@bot-whatsapp/bot');
const { TwilioProvider } = require('@bot-whatsapp/provider-twilio');
const MockAdapter = require('@bot-whatsapp/database/mock');
const axios = require('axios');
require('dotenv').config();

// Variables globales
let pedidoActual = [];
let pedidoID = '';
let clienteInfo = {};
let estado = 'inicio';
let contador = 1;

// Generar ID tipo PED-00001
const generarPedidoID = () => `PED-${String(contador).padStart(5, '0')}`;

// Obtener productos desde AppSheet
const obtenerProductos = async () => {
  try {
    const url = `https://api.appsheet.com/api/v2/apps/${process.env.APPSHEET_APP_ID}/tables/Productos`;
    const res = await axios.get(url, {
      headers: { 'ApplicationAccessKey': process.env.APPSHEET_API_KEY }
    });
    return res.data?.data || [];
  } catch (err) {
    console.error('❌ Error obteniendo productos:', err.message);
    return [];
  }
};

// Guardar pedido
const guardarPedido = async () => {
  try {
    const fecha = new Date().toISOString();
    const total = pedidoActual.reduce((acc, p) => acc + p.valor, 0);

    await axios.post(`https://api.appsheet.com/api/v2/apps/${process.env.APPSHEET_APP_ID}/tables/enc_pedido/Action`, {
      Action: 'Add',
      Properties: {},
      Rows: [{
        pedidoid: pedidoID,
        enc_total: total,
        fecha,
        cliente: clienteInfo.nombre,
        direccion: clienteInfo.direccion,
        celular: clienteInfo.celular
      }]
    }, {
      headers: { 'ApplicationAccessKey': process.env.APPSHEET_API_KEY }
    });

    const detalles = pedidoActual.map(p => ({
      pedidoid: pedidoID,
      fecha,
      nombreProducto: p.nombreProducto,
      cantidadProducto: p.cantidadProducto,
      valor_unit: p.valor_unit,
      valor: p.valor
    }));

    await axios.post(`https://api.appsheet.com/api/v2/apps/${process.env.APPSHEET_APP_ID}/tables/pedido/Action`, {
      Action: 'Add',
      Properties: {},
      Rows: detalles
    }, {
      headers: { 'ApplicationAccessKey': process.env.APPSHEET_API_KEY }
    });

    console.log('✅ Pedido guardado:', pedidoID);
    pedidoActual = [];
    clienteInfo = {};
    estado = 'inicio';
    contador++;
  } catch (err) {
    console.error('❌ Error guardando pedido:', err.message);
  }
};

// Flujo inicial
const flujoPrincipal = addKeyword(['Hola'])
  .addAnswer('👋 Bienvenido. Escribe *pedido* para iniciar o *fin* para salir.')
  .addAction(async (ctx, { flowDynamic, fallBack }) => {
    const mensaje = ctx.body.trim().toLowerCase();

    if (mensaje === 'fin') {
      estado = 'inicio';
      return await flowDynamic('✅ Pedido cancelado. ¡Hasta pronto!');
    }
    if (mensaje === 'pedido' || mensaje === 'hola') {
      estado = 'datos_cliente';
      return await flowDynamic('📋 Escribe tu nombre:');
    }

    return fallBack();
  });

// Flujo de datos y productos
const flujoDatosCliente = addKeyword(['buenas'])  // ✅ Eliminamos 'hola' para evitar conflicto
  .addAction(async (ctx, { flowDynamic, state, fallBack }) => {
    const input = ctx.body.trim();

    if (estado === 'datos_cliente' && !clienteInfo.nombre) {
      clienteInfo.nombre = input;
      estado = 'direccion';
      return await flowDynamic('🏠 Escribe tu dirección:');
    }

    if (estado === 'direccion' && !clienteInfo.direccion) {
      clienteInfo.direccion = input;
      estado = 'celular';
      return await flowDynamic('📱 Escribe tu celular (10 dígitos):');
    }

    if (estado === 'celular' && !clienteInfo.celular) {
      if (!/^\d{10}$/.test(input)) {
        return await flowDynamic('❌ El celular debe tener 10 dígitos. Intenta de nuevo:');
      }
      clienteInfo.celular = input;
      estado = 'producto';
      pedidoID = generarPedidoID();
      return await flowDynamic(`✅ Datos registrados. Tu número de pedido es *${pedidoID}*\n\n📦 Escribe el nombre del producto:`);
    }

    if (estado === 'producto') {
      if (input.toLowerCase() === 'fin') {
        if (pedidoActual.length === 0) return await flowDynamic('❌ No hay productos agregados.');
        const resumen = pedidoActual.map(p => `🧴 ${p.nombreProducto} x${p.cantidadProducto} = $${p.valor}`).join('\n');
        await flowDynamic(`🧾 Resumen del pedido:\n${resumen}`);
        await guardarPedido();
        return await flowDynamic('✅ Pedido guardado. ¡Gracias por tu compra!');
      }

      const productos = await obtenerProductos();
      const encontrados = productos.filter(p => p.nombreProducto?.toLowerCase().includes(input.toLowerCase()));

      if (!encontrados.length) {
        return await flowDynamic('❌ Producto no encontrado. Intenta otro nombre.');
      }

      const lista = encontrados.map(p => `➡️ ${p.nombreProducto} - $${p.valor}`).join('\n');
      await state.update({ seleccionados: encontrados });
      estado = 'esperando_seleccion';
      return await flowDynamic(`Selecciona uno:\n${lista}\n\nEscribe el *nombre exacto* del producto:`);
    }

    if (estado === 'esperando_seleccion') {
      const seleccionados = await state.get('seleccionados');
      const producto = seleccionados.find(p => p.nombreProducto.toLowerCase() === input.toLowerCase());

      if (!producto) {
        return await flowDynamic('❌ Producto inválido. Escribe el nombre exacto de la lista.');
      }

      await state.update({ productoSeleccionado: producto });
      estado = 'cantidad';
      return await flowDynamic(`¿Cuántas unidades de *${producto.nombreProducto}* deseas?`);
    }

    if (estado === 'cantidad') {
      const cantidad = parseInt(input);
      if (isNaN(cantidad) || cantidad <= 0) {
        return await flowDynamic('❌ Cantidad inválida. Intenta de nuevo:');
      }

      const producto = await state.get('productoSeleccionado');
      const valor = cantidad * producto.valor;

      pedidoActual.push({
        nombreProducto: producto.nombreProducto,
        cantidadProducto: cantidad,
        valor_unit: producto.valor,
        valor
      });

      estado = 'producto';
      return await flowDynamic(`✅ Producto agregado.\n\nEscribe otro producto o *fin* para terminar el pedido.`);
    }

    return fallBack();
  });

// Main
const main = async () => {
  const adapterDB = new MockAdapter();
  const adapterFlow = createFlow([flujoPrincipal, flujoDatosCliente]);
  const adapterProvider = createProvider(TwilioProvider,{
    accountSid: process.env.TWILIO_ACCOUNT_SID,
    authToken: process.env.TWILIO_AUTH_TOKEN,
    phoneNumber: process.env.TWILIO_PHONE_NUMBER,
  });

  await createBot({
    flow: adapterFlow,
    provider: adapterProvider,
    database: adapterDB,
  });

  console.log('🤖 Bot iniciado correctamente con Twilio');
};

main();