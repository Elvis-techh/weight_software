/**
 * Historial de Cambios — the read side of the auditoría table.
 *
 * The backend records a full before/after snapshot of every edited or deleted
 * row (see logAudit/diffSnapshots in server.js) and returns the fields that
 * actually moved as `cambios`. Everything here is presentation: turning the
 * raw field names those snapshots carry into Spanish labels and formatted
 * values, so a row reads "Precio aplicado: L 450.00 → L 500.00" instead of
 * "precioAplicado: 450 → 500".
 *
 * Unlike the other tabs, this one is not loaded at boot: the log only matters
 * when someone goes looking for it, and it is fetched per date range rather
 * than held in memory in full.
 */

let auditoriaData = [];
let auditoriaTruncada = false;
let auditoriaCargando = false;

// Fields whose value is money, a weight in pounds, a date, or a boolean.
// Anything not listed is rendered as plain text.
const AUDITORIA_CAMPOS_MONEDA = new Set([
    'precioAplicado', 'total', 'monto', 'precio', 'sueldoBase', 'extras',
    'precioFletePropio', 'precioFleteCliente',
    'precioToneladaPropio', 'precioToneladaCliente', 'precioToneladaDirecto'
]);
const AUDITORIA_CAMPOS_PESO = new Set(['pesoBruto', 'pesoTara', 'neto']);
const AUDITORIA_CAMPOS_FECHA = new Set(['fecha', 'fechaEntrada', 'fechaPago', 'periodoInicio', 'periodoFin']);
const AUDITORIA_CAMPOS_BOOLEANO = new Set(['pagado', 'excluido', 'esProductoPropio', 'trabajado', 'hasFile', 'hasFileNuestro']);

const AUDITORIA_ETIQUETAS_CAMPO = Object.freeze({
    fecha: 'Fecha',
    hora: 'Hora',
    fechaEntrada: 'Fecha de entrada',
    horaEntrada: 'Hora de entrada',
    placa: 'Placa',
    conductor: 'Conductor',
    clienteNombre: 'Cliente',
    identidad: 'Identidad',
    numeroBoleta: 'N° de boleta',
    pesoBruto: 'Peso bruto',
    pesoTara: 'Peso tara',
    neto: 'Peso neto',
    precioAplicado: 'Precio aplicado',
    total: 'Total',
    unidad: 'Unidad',
    // Camiones en patio
    clienteId: 'Cliente (id)',
    clienteNombreSnapshot: 'Cliente',
    identidadSnapshot: 'Identidad',
    flete: 'Tipo de flete',
    // Clientes
    nombre: 'Nombre',
    apellido: 'Apellido',
    telefono: 'Teléfono',
    ubicacion: 'Ubicación',
    categoria: 'Categoría',
    precioFletePropio: 'Precio flete propio',
    precioFleteCliente: 'Precio flete cliente',
    precioToneladaPropio: 'Precio por tonelada (propio)',
    precioToneladaCliente: 'Precio por tonelada (cliente)',
    precioToneladaDirecto: 'Precio por tonelada (directo)',
    // Recibos externos
    reciboIn: 'Recibo entrada',
    reciboOut: 'Recibo salida',
    cliente: 'Cliente',
    destino: 'Destino',
    aNombreDe: 'A nombre de',
    toneladas: 'Toneladas',
    precio: 'Precio',
    pagado: 'Pagado',
    excluido: 'Excluido',
    esProductoPropio: 'Producto propio',
    fileName: 'Archivo',
    fileNuestro: 'Archivo nuestro',
    hasFile: 'Tiene archivo',
    hasFileNuestro: 'Tiene archivo nuestro',
    // Gastos
    concepto: 'Concepto',
    monto: 'Monto',
    notas: 'Notas',
    // Pagos Corapsa
    fechaPago: 'Fecha de pago',
    periodoInicio: 'Inicio del período',
    periodoFin: 'Fin del período',
    referencia: 'Referencia',
    // Planilla
    sueldoBase: 'Sueldo base',
    diasTrabajados: 'Días trabajados',
    extras: 'Extras',
    trabajado: 'Trabajó',
    horaInicio: 'Hora de entrada',
    horaFin: 'Hora de salida'
});

const AUDITORIA_ETIQUETAS_ENTIDAD = Object.freeze({
    transaccion: 'Transacción',
    cliente: 'Cliente',
    clientes: 'Clientes',
    corapsa: 'Recibo externo',
    pago_corapsa: 'Pago Corapsa',
    gasto: 'Gasto',
    trabajador: 'Trabajador',
    asistencia: 'Asistencia',
    planilla_periodo: 'Período de planilla',
    camion_patio: 'Camión en patio',
    company: 'Empresa'
});

const AUDITORIA_ETIQUETAS_ACCION = Object.freeze({
    crear: 'Creado',
    editar: 'Editado',
    eliminar: 'Eliminado',
    finalizar: 'Finalizado',
    actualizar_peso: 'Peso actualizado',
    sobrescribir_peso_bruto: 'Peso bruto sobrescrito',
    actualizar_archivo: 'Archivo actualizado',
    actualizar_parcial: 'Actualizado',
    editar_precio_pesaje: 'Precio editado en Pesaje',
    ajuste_global: 'Ajuste global de precios',
    actualizar_extras: 'Extras actualizados',
    registrar_jornada: 'Jornada registrada',
    marcar_no_trabajado: 'Marcado como no trabajado'
});

// Actions that remove or overwrite data get a red badge; the rest are neutral.
const AUDITORIA_ACCIONES_DESTRUCTIVAS = new Set(['eliminar', 'sobrescribir_peso_bruto']);

// Bookkeeping fields carried by the mappers that mean nothing to an operator
// reading a created/deleted record: internal ids, write timestamps, MIME types,
// the has-a-file booleans (the file name beside them already says it), and the
// justification (which the table shows in its own column). Mirrors
// AUDIT_IGNORED_FIELDS in server.js, which keeps the same noise out of diffs.
const AUDITORIA_CAMPOS_OCULTOS = new Set([
    'id', 'createdAt', 'updatedAt', 'justificacion',
    'fileMimeType', 'fileNuestroMimeType', 'hasFile', 'hasFileNuestro',
    'casualSnapshot'
]);

function etiquetaCampoAuditoria(campo) {
    return AUDITORIA_ETIQUETAS_CAMPO[campo] || campo;
}

function etiquetaEntidadAuditoria(entidad) {
    return AUDITORIA_ETIQUETAS_ENTIDAD[entidad] || entidad;
}

function etiquetaAccionAuditoria(accion) {
    return AUDITORIA_ETIQUETAS_ACCION[accion] || accion;
}

function formatearValorAuditoria(campo, valor) {
    if (valor === null || valor === undefined || valor === '') return '—';
    if (AUDITORIA_CAMPOS_BOOLEANO.has(campo)) return valor ? 'Sí' : 'No';
    if (AUDITORIA_CAMPOS_MONEDA.has(campo)) return `L ${formatMoney(valor)}`;
    if (AUDITORIA_CAMPOS_PESO.has(campo)) return `${toFiniteNumber(valor).toLocaleString('en-US')} LBS`;
    if (AUDITORIA_CAMPOS_FECHA.has(campo)) return formatDateForDisplay(valor);
    if (typeof valor === 'number') return valor.toLocaleString('en-US');
    return String(valor);
}

// 'YYYY-MM-DD HH:MM:SS' (already local — see auditoria.registrado_en) split
// into the two pieces the table shows in separate lines.
function partirFechaHoraAuditoria(valor) {
    const [fecha = '', hora = ''] = String(valor || '').split(' ');
    return { fecha: formatDateForDisplay(fecha), hora: hora.slice(0, 5) };
}

// Identifies the affected record the way the operator would recognize it —
// boleta number, receipt number, concept — falling back to the raw id.
function describirRegistroAuditoria(movimiento) {
    const datos = movimiento.antes || movimiento.despues || movimiento.detalles || {};
    const partes = [];

    if (datos.numeroBoleta != null) partes.push(`Boleta ${datos.numeroBoleta}`);
    else if (datos.reciboIn) partes.push(`Recibo ${datos.reciboIn}`);
    else if (movimiento.entidadId) partes.push(`#${movimiento.entidadId}`);

    const nombre = datos.clienteNombre || datos.cliente || datos.concepto
        || [datos.nombre, datos.apellido].filter(Boolean).join(' ').trim();
    if (nombre) partes.push(nombre);

    return partes.join(' · ') || '—';
}

// A creation or a deletion has only one side to show, so the snapshot itself
// is the record: the values the row was born with, or the ones it held when it
// was removed. Returns [[campo, valor]] minus the bookkeeping fields.
function camposDelSnapshotAuditoria(movimiento) {
    const datos = movimiento.accion === 'eliminar'
        ? movimiento.antes
        : movimiento.despues || movimiento.detalles;
    if (!datos || typeof datos !== 'object') return [];

    return Object.entries(datos)
        .filter(([campo, valor]) => !AUDITORIA_CAMPOS_OCULTOS.has(campo)
            && valor !== '' && valor !== null && valor !== undefined);
}

// 'finalizar' is how a weigh-in becomes a transaction, so it is a creation as
// far as this table is concerned.
const AUDITORIA_ACCIONES_SNAPSHOT = new Set(['eliminar', 'crear', 'finalizar']);

function esMovimientoDeSnapshot(movimiento) {
    return AUDITORIA_ACCIONES_SNAPSHOT.has(movimiento.accion);
}

function renderSnapshotAuditoria(movimiento) {
    const campos = camposDelSnapshotAuditoria(movimiento);
    if (campos.length === 0) {
        return `<span class="text-gray-400 italic">Sin detalle del registro ${movimiento.accion === 'eliminar' ? 'eliminado' : 'creado'}.</span>`;
    }

    return `<div class="grid grid-cols-1 sm:grid-cols-2 gap-x-4 gap-y-0.5 text-xs">${campos.map(([campo, valor]) => `
        <div class="flex gap-1.5 items-baseline">
            <span class="text-gray-500">${escapeHtml(etiquetaCampoAuditoria(campo))}:</span>
            <span class="font-mono text-gray-700">${escapeHtml(formatearValorAuditoria(campo, valor))}</span>
        </div>
    `).join('')}</div>`;
}

function renderListaCambios(movimiento) {
    if (esMovimientoDeSnapshot(movimiento)) return renderSnapshotAuditoria(movimiento);

    if (!Array.isArray(movimiento.cambios) || movimiento.cambios.length === 0) {
        // The save went through without actually altering any value — worth
        // showing rather than hiding, since the justification was still given.
        return '<span class="text-gray-400 italic">Sin cambios de valores.</span>';
    }

    return `<div class="flex flex-col gap-1">${movimiento.cambios.map(cambio => `
        <div class="flex flex-wrap items-baseline gap-1.5 text-xs">
            <span class="font-semibold text-gray-600">${escapeHtml(etiquetaCampoAuditoria(cambio.campo))}:</span>
            <span class="font-mono text-red-600 line-through decoration-red-300">${escapeHtml(formatearValorAuditoria(cambio.campo, cambio.antes))}</span>
            <span class="material-icons text-[14px] text-gray-400 leading-none">arrow_forward</span>
            <span class="font-mono font-bold text-green-700">${escapeHtml(formatearValorAuditoria(cambio.campo, cambio.despues))}</span>
        </div>
    `).join('')}</div>`;
}

// The field labels a row actually displays, so searching "precio" matches both
// an edit that changed the price and a deletion whose record carried one.
function etiquetasVisiblesAuditoria(movimiento) {
    return esMovimientoDeSnapshot(movimiento)
        ? camposDelSnapshotAuditoria(movimiento).map(([campo]) => etiquetaCampoAuditoria(campo))
        : (movimiento.cambios || []).map(cambio => etiquetaCampoAuditoria(cambio.campo));
}

function renderAuditoria() {
    const tbody = document.getElementById('auditoria-table-body');
    if (!tbody) return;

    const aviso = document.getElementById('auditoria-truncado');
    if (aviso) aviso.classList.toggle('hidden', !auditoriaTruncada);

    if (auditoriaCargando) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-gray-400">Cargando historial…</td></tr>';
        return;
    }

    const startDate = document.getElementById('auditoria-filter-start')?.value || '';
    const endDate = document.getElementById('auditoria-filter-end')?.value || '';
    if (startDate && endDate && startDate > endDate) {
        tbody.innerHTML = '<tr><td colspan="5" class="p-8 text-center text-red-600 font-bold">La fecha “Desde” no puede ser posterior a la fecha “Hasta”.</td></tr>';
        return;
    }

    const busquedaRaw = document.getElementById('auditoria-filter-search')?.value || '';
    const busqueda = busquedaRaw.trim().toLocaleLowerCase('es');

    const registros = auditoriaData.filter(movimiento => {
        if (!busqueda) return true;
        // Matches the justification, the record description, and the field
        // labels, so "precio" finds every row whose price was touched.
        const heno = [
            movimiento.justificacion,
            describirRegistroAuditoria(movimiento),
            etiquetaEntidadAuditoria(movimiento.entidad),
            etiquetaAccionAuditoria(movimiento.accion),
            ...etiquetasVisiblesAuditoria(movimiento)
        ].join(' ').toLocaleLowerCase('es');
        return heno.includes(busqueda);
    });

    document.getElementById('auditoria-total').textContent = String(registros.length);
    document.getElementById('auditoria-ediciones').textContent =
        String(registros.filter(m => !esMovimientoDeSnapshot(m)).length);
    document.getElementById('auditoria-eliminaciones').textContent =
        String(registros.filter(m => m.accion === 'eliminar').length);

    if (registros.length === 0) {
        const mensaje = auditoriaData.length > 0
            ? 'No se encontraron cambios para los filtros seleccionados.'
            : 'Sin cambios registrados en este período.';
        tbody.innerHTML = `<tr><td colspan="5" class="p-8 text-center text-gray-400">${mensaje}</td></tr>`;
        return;
    }

    tbody.innerHTML = registros.map(movimiento => {
        const { fecha, hora } = partirFechaHoraAuditoria(movimiento.fecha);
        const destructiva = AUDITORIA_ACCIONES_DESTRUCTIVAS.has(movimiento.accion);
        const badge = destructiva
            ? 'bg-red-100 text-red-700'
            : movimiento.accion === 'crear'
                ? 'bg-green-100 text-green-700'
                : 'bg-blue-100 text-blue-700';

        return `
        <tr class="hover:bg-slate-50 align-top">
            <td class="p-4 font-mono text-gray-600 whitespace-nowrap" data-label="Fecha">
                <div class="font-bold text-gray-700">${escapeHtml(fecha)}</div>
                <div class="text-xs text-gray-400">${escapeHtml(hora)}</div>
            </td>
            <td class="p-4" data-label="Módulo">
                <div class="font-bold text-gray-800">${escapeHtml(etiquetaEntidadAuditoria(movimiento.entidad))}</div>
                <div class="text-xs text-gray-500">${escapeHtml(describirRegistroAuditoria(movimiento))}</div>
            </td>
            <td class="p-4" data-label="Acción">
                <span class="inline-block px-2 py-0.5 rounded-full text-xs font-bold ${badge}">${escapeHtml(etiquetaAccionAuditoria(movimiento.accion))}</span>
            </td>
            <td class="p-4 min-w-[16rem]" data-label="Cambios">${renderListaCambios(movimiento)}</td>
            <td class="p-4 text-xs text-gray-600 italic max-w-xs" data-label="Justificación">${escapeHtml(movimiento.justificacion || '—')}</td>
        </tr>`;
    }).join('');
}

async function fetchAuditoria() {
    const inicio = document.getElementById('auditoria-filter-start')?.value || '';
    const fin = document.getElementById('auditoria-filter-end')?.value || '';
    if (!inicio || !fin || inicio > fin) {
        // renderAuditoria() surfaces the inverted-range message itself; an
        // incomplete range just means the operator is still picking dates.
        renderAuditoria();
        return;
    }

    auditoriaCargando = true;
    renderAuditoria();

    try {
        const result = await apiRequest(
            `/api/auditoria?inicio=${encodeURIComponent(inicio)}&fin=${encodeURIComponent(fin)}`,
            // The log covers every module at once, so a wide range returns far
            // more rows than a single-tab fetch — allow longer than the default.
            { timeoutMs: 20000 }
        );
        auditoriaData = Array.isArray(result?.movimientos) ? result.movimientos : [];
        auditoriaTruncada = Boolean(result?.truncado);
    } catch (error) {
        console.error('No se pudo cargar el historial de cambios:', error);
        auditoriaData = [];
        auditoriaTruncada = false;
        mostrarNotificacion(error.message || 'No se pudo cargar el historial de cambios.', 'error');
    } finally {
        auditoriaCargando = false;
        renderAuditoria();
    }
}
