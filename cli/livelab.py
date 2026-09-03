#!/usr/bin/env python3
"""livelab — linha de comando da API do Livelab para automação.

Feito para rodar no terminal de uma VM (o Grok bot, por exemplo) sem instalar
nada: só Python 3.8+ e a biblioteca padrão.

Uso rápido:
  export LIVELAB_API_KEY=llk_...
  python3 livelab.py rotas
  python3 livelab.py api GET /v1/lives -q data_inicio=2026-09-01
  python3 livelab.py api POST /v1/marcas -d '{"nome":"Marca X","tipo":"afiliada"}'
  python3 livelab.py ingest relatorio.xlsx --marca-id <uuid> --apresentadora-id <uuid>

Saída: o body JSON da API em stdout. Erro em stderr.
Códigos de saída: 0 ok · 1 a API recusou (status fora de 2xx) · 2 uso errado
(chave ausente, arquivo grande, JSON inválido) · 3 rede/DNS/timeout.
"""

import argparse
import base64
import json
import os
import socket
import sys
import urllib.error
import urllib.parse
import urllib.request

BASE_PADRAO = 'https://liveshop-saas-api-production.up.railway.app'
TETO_ARQUIVO_BYTES = 5 * 1024 * 1024
TIMEOUT_SEGUNDOS = 60

SAIDA_API = 1
SAIDA_USO = 2
SAIDA_REDE = 3

# Espelho da allowlist ROTAS_API_KEY em src/plugins/auth.js. Mantida à mão;
# o teste confere que cada linha aqui passa em chaveAlcancaRota.
ROTAS = [
    ('POST', '/v1/analytics/imports/ingest', 'Mandar relatório do TikTok e aplicar'),
    ('POST', '/v1/analytics/imports/preview', 'Só analisar o relatório, sem aplicar'),
    ('GET', '/v1/analytics/imports', 'Listar lotes de import'),
    ('GET', '/v1/analytics/imports/:id', 'Ver um lote e o estado de cada linha'),
    ('GET', '/v1/lives', 'Listar lives'),
    ('GET', '/v1/lives/:id', 'Ver uma live'),
    ('POST', '/v1/lives/manual', 'Cadastrar live já encerrada (data, hora, GMV, pedidos)'),
    ('POST', '/v1/lives', 'Iniciar live ao vivo numa cabine'),
    ('PATCH', '/v1/lives/:id', 'Editar live'),
    ('GET', '/v1/marcas', 'Listar marcas'),
    ('POST', '/v1/marcas', 'Cadastrar marca'),
    ('PATCH', '/v1/marcas/:id', 'Editar marca'),
    ('GET', '/v1/apresentadoras', 'Listar apresentadoras'),
    ('PATCH', '/v1/apresentadoras/:id', 'Editar apresentadora'),
    ('GET', '/v1/comissoes', 'Ler comissão calculada'),
]


def falhar(mensagem, codigo):
    print(mensagem, file=sys.stderr)
    sys.exit(codigo)


def chave():
    valor = os.environ.get('LIVELAB_API_KEY', '').strip()
    if not valor:
        falhar('LIVELAB_API_KEY não definida', SAIDA_USO)
    return valor


def base_url():
    return os.environ.get('LIVELAB_API_URL', BASE_PADRAO).strip().rstrip('/')


def normalizar_rota(rota):
    rota = rota.strip()
    if not rota.startswith('/'):
        rota = '/' + rota
    if rota != '/v1' and not rota.startswith('/v1/'):
        rota = '/v1' + rota
    return rota


def chamar(metodo, rota, query=None, body=None, verbose=False):
    """Faz a chamada e imprime a resposta. Devolve 0 no 2xx; sai com 1/3 senão."""
    url = base_url() + normalizar_rota(rota)
    if query:
        url += ('&' if '?' in url else '?') + urllib.parse.urlencode(query)
    dados = None
    cabecalhos = {
        'X-API-Key': chave(),
        'Accept': 'application/json',
        'User-Agent': 'livelab-cli/1.0',
    }
    if body is not None:
        dados = json.dumps(body, ensure_ascii=False).encode('utf-8')
        cabecalhos['Content-Type'] = 'application/json'
    requisicao = urllib.request.Request(url, data=dados, method=metodo, headers=cabecalhos)

    try:
        with urllib.request.urlopen(requisicao, timeout=TIMEOUT_SEGUNDOS) as resposta:
            status = resposta.status
            texto = resposta.read().decode('utf-8', errors='replace')
    except urllib.error.HTTPError as erro:
        status = erro.code
        texto = erro.read().decode('utf-8', errors='replace')
    except (urllib.error.URLError, socket.timeout, OSError) as erro:
        motivo = getattr(erro, 'reason', None) or erro
        if verbose:
            print('%s %s -> sem resposta' % (metodo, url), file=sys.stderr)
        falhar('erro de rede ao chamar a API: %s' % motivo, SAIDA_REDE)

    if verbose:
        print('%s %s -> %s' % (metodo, url, status), file=sys.stderr)

    try:
        corpo = json.loads(texto) if texto else None
    except ValueError:
        corpo = texto

    if 200 <= status < 300:
        print(json.dumps(corpo, ensure_ascii=False, indent=2))
        return 0

    print(json.dumps({'status': status, 'error': corpo}, ensure_ascii=False), file=sys.stderr)
    if status == 403:
        print('rota não liberada para chave de API — veja: livelab rotas', file=sys.stderr)
    sys.exit(SAIDA_API)


def ler_body(args):
    """Body de -d (JSON inline) ou -f (arquivo; '-' lê stdin). Nenhum: None."""
    if getattr(args, 'data', None) is not None and getattr(args, 'file', None) is not None:
        falhar('use -d ou -f, não os dois', SAIDA_USO)
    texto = None
    if getattr(args, 'data', None) is not None:
        texto = args.data
    elif getattr(args, 'file', None) is not None:
        try:
            texto = sys.stdin.read() if args.file == '-' else open(args.file, 'r', encoding='utf-8').read()
        except OSError as erro:
            falhar('não consegui ler %s: %s' % (args.file, erro), SAIDA_USO)
    if texto is None:
        return None
    try:
        return json.loads(texto)
    except ValueError as erro:
        falhar('body não é JSON válido: %s' % erro, SAIDA_USO)


def ler_query(pares):
    query = []
    for par in pares or []:
        if '=' not in par:
            falhar('-q espera chave=valor, recebeu %r' % par, SAIDA_USO)
        chave_, valor = par.split('=', 1)
        query.append((chave_, valor))
    return query


def cmd_api(args):
    return chamar(args.metodo.upper(), args.rota, ler_query(args.query), ler_body(args), getattr(args, 'verbose', False))


def cmd_ingest(args):
    try:
        with open(args.arquivo, 'rb') as arquivo:
            conteudo = arquivo.read()
    except OSError as erro:
        falhar('não consegui ler %s: %s' % (args.arquivo, erro), SAIDA_USO)
    if len(conteudo) > TETO_ARQUIVO_BYTES:
        falhar('arquivo com %d bytes passa do teto de %d bytes; divida a planilha'
               % (len(conteudo), TETO_ARQUIVO_BYTES), SAIDA_USO)
    body = {
        'filename': os.path.basename(args.arquivo),
        'content_base64': base64.b64encode(conteudo).decode('ascii'),
    }
    if args.marca_id:
        body['marca_id'] = args.marca_id
    if args.apresentadora_id:
        body['apresentadora_id'] = args.apresentadora_id
    if args.criar_lives:
        body['criar_lives'] = True
    rota = '/v1/analytics/imports/preview' if args.preview else '/v1/analytics/imports/ingest'
    return chamar('POST', rota, None, body, getattr(args, 'verbose', False))


def cmd_rotas(args):
    largura = max(len(r[1]) for r in ROTAS)
    for metodo, rota, uso in ROTAS:
        print('%-5s %-*s  %s' % (metodo, largura, rota, uso))
    return 0


def montar_parser():
    comum = argparse.ArgumentParser(add_help=False)
    # SUPPRESS: sem isso o subcomando zera o --verbose dado antes dele.
    comum.add_argument('--verbose', action='store_true', default=argparse.SUPPRESS,
                       help='imprime método, URL e status em stderr')

    parser = argparse.ArgumentParser(
        prog='livelab', parents=[comum],
        description='CLI da API do Livelab para automação. Chave em LIVELAB_API_KEY; '
                    'base em LIVELAB_API_URL (padrão: produção).',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='Códigos de saída: 0 ok · 1 API recusou · 2 uso errado · 3 rede.',
    )
    sub = parser.add_subparsers(dest='comando', metavar='comando')
    sub.required = True

    p_api = sub.add_parser('api', parents=[comum], help='chamada crua: api <GET|POST|PATCH> <rota> [-q k=v] [-d JSON | -f arquivo]')
    p_api.add_argument('metodo', choices=['GET', 'POST', 'PATCH', 'get', 'post', 'patch'])
    p_api.add_argument('rota', help='ex.: /v1/lives ou só lives (o /v1 é adicionado)')
    p_api.add_argument('-q', '--query', action='append', metavar='k=v', help='parâmetro de query; repetível')
    p_api.add_argument('-d', '--data', metavar='JSON', help='body JSON inline')
    p_api.add_argument('-f', '--file', metavar='ARQUIVO', help="body JSON lido de arquivo ('-' = stdin)")
    p_api.set_defaults(func=cmd_api)

    p_ing = sub.add_parser('ingest', parents=[comum], help='manda um CSV/XLSX do TikTok para o import')
    p_ing.add_argument('arquivo', help='relatório TikTok Ads ou Creator Live Performance (CSV/XLSX)')
    p_ing.add_argument('--marca-id', help='obrigatório no Creator Live Performance')
    p_ing.add_argument('--apresentadora-id', help='obrigatório no Creator Live Performance')
    p_ing.add_argument('--criar-lives', action='store_true', help='cria live para linha que não casou com nenhuma')
    p_ing.add_argument('--preview', action='store_true', help='só analisa, não aplica')
    p_ing.set_defaults(func=cmd_ingest)

    p_rotas = sub.add_parser('rotas', parents=[comum], help='lista o que a chave alcança')
    p_rotas.set_defaults(func=cmd_rotas)

    return parser


def main(argv=None):
    parser = montar_parser()
    args = parser.parse_args(argv)
    return args.func(args) or 0


if __name__ == '__main__':
    sys.exit(main())
