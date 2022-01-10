const mongoose = require('mongoose');
mongoose.set('useUnifiedTopology', true);

const CachedResponseSchema = new mongoose.Schema({
	url: {
		type: String,
		required: true
	},
	data: {
		type: String,
		required: true
	}
}, {
	timestamps: {
		createdAt: true
	}
});

module.exports = mongoose.model('CachedResponse', CachedResponseSchema);
