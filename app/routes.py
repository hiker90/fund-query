from flask import jsonify, request, render_template
from app import app
from app.services.fund_api import fund_api_service

# 获取基金基本信息
@app.route('/api/fund/info/<code>', methods=['GET'])
def get_fund_info(code):
    try:
        fund = fund_api_service.get_fund_info(code)
        if fund:
            return jsonify(fund)
        else:
            return jsonify({'error': '基金不存在'}), 404
    except Exception as e:
        return jsonify({'error': f'获取基金信息失败: {str(e)}'}), 500

# 获取基金历史走势
@app.route('/api/fund/history/<code>', methods=['GET'])
def get_fund_history(code):
    try:
        days = request.args.get('days', 30, type=int)
        history = fund_api_service.get_fund_history(code, days)
        return jsonify(history)
    except Exception as e:
        return jsonify({'error': f'获取基金历史走势失败: {str(e)}'}), 500

# 获取基金估值数据
@app.route('/api/fund/valuation/<code>', methods=['GET'])
def get_fund_valuation(code):
    try:
        valuation = fund_api_service.get_fund_valuation(code)
        if valuation:
            return jsonify(valuation)
        else:
            return jsonify({'error': '基金不存在'}), 404
    except Exception as e:
        return jsonify({'error': f'获取基金估值数据失败: {str(e)}'}), 500

# 搜索基金
@app.route('/api/fund/search', methods=['GET'])
def search_funds():
    try:
        keyword = request.args.get('keyword', '', type=str)
        funds = fund_api_service.search_funds(keyword)
        return jsonify(funds)
    except Exception as e:
        return jsonify({'error': f'搜索基金失败: {str(e)}'}), 500

# 根路径，返回前端页面
@app.route('/')
def index():
    return render_template('index.html')
